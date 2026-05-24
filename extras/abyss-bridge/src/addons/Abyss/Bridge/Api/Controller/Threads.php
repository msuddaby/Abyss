<?php

namespace Abyss\Bridge\Api\Controller;

use XF\Api\Controller\AbstractController;
use XF\Mvc\ParameterBag;

/**
 * POST /api/abyss/threads
 *
 * Headers:   XF-Api-Key: <super-user key>   (required; XF enforces via the api_endpoint scope)
 *
 * Body (JSON):
 *   {
 *     "node_id": 12,
 *     "title": "Cool thread",
 *     "posts": [
 *       { "mode": "real",  "xf_user_id": 42, "bbcode": "First message..." },
 *       { "mode": "ghost", "abyss_user_id": "abc-123", "display_name": "Alice",
 *         "avatar_url": "https://abyss.example.com/uploads/a.png", "bbcode": "..." }
 *     ]
 *   }
 *
 * Response: { "thread_id": 1234, "url": "https://forum.example.com/threads/cool-thread.1234/" }
 */
class Threads extends AbstractController
{
    public function actionPost(ParameterBag $params)
    {
        // XF's filter() reads $_POST + $_GET; PHP doesn't populate $_POST for
        // application/json bodies, so read the raw body ourselves when the
        // Content-Type is JSON. Falls back to filter() for form-encoded callers.
        $contentType = strtolower((string)$this->request->getServer('CONTENT_TYPE'));
        $body = [];
        if (strpos($contentType, 'application/json') !== false) {
            $raw = file_get_contents('php://input');
            if ($raw !== false && $raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $body = $decoded;
                }
            }
        }
        if (!$body) {
            $body = $this->filter([
                'node_id' => 'uint',
                'title' => 'str',
                'posts' => 'array',
            ]);
        }

        $nodeId = isset($body['node_id']) ? (int)$body['node_id'] : 0;
        $title = isset($body['title']) ? (string)$body['title'] : '';
        $posts = isset($body['posts']) && is_array($body['posts']) ? $body['posts'] : [];

        if (!$nodeId) {
            return $this->error('node_id required', 400);
        }
        if ($title === '' || mb_strlen($title) > 150) {
            return $this->error('title must be 1-150 chars', 400);
        }
        if (empty($posts)) {
            return $this->error('posts must be a non-empty array', 400);
        }

        /** @var \XF\Entity\Forum|null $forum */
        $forum = $this->em()->find('XF:Forum', $nodeId);
        if (!$forum) {
            return $this->error('forum not found', 404);
        }

        $ghostUserId = (int)$this->options()->abyssBridgeGhostUserId;
        if (!$ghostUserId) {
            return $this->error('Abyss bridge ghost_user_id is not configured', 500);
        }
        /** @var \XF\Entity\User|null $ghostUser */
        $ghostUser = $this->em()->find('XF:User', $ghostUserId);
        if (!$ghostUser) {
            return $this->error('Configured ghost user does not exist', 500);
        }

        // The first post becomes the thread OP; subsequent posts are replies.
        $posts = array_values($posts);
        $first = $posts[0];
        $firstAuthor = $this->resolveAuthor($first, $ghostUser);
        if (!$firstAuthor) {
            return $this->error('First post author could not be resolved', 400);
        }

        $thread = null;
        try {
            $self = $this;
            \XF::asVisitor($firstAuthor, function () use ($self, $forum, $title, $first, &$thread) {
                /** @var \XF\Service\Thread\Creator $creator */
                $creator = $self->app()->service('XF:Thread\\Creator', $forum);
                if (method_exists($creator, 'setIsAutomated')) {
                    $creator->setIsAutomated();
                }
                $creator->setContent($title, $self->renderPostBodyPublic($first));
                if (!$creator->validate($errors)) {
                    throw new \RuntimeException('Thread validation failed: ' . implode('; ', $errors));
                }
                $thread = $creator->save();
            });
        } catch (\Throwable $e) {
            \XF::logException($e, false, '[Abyss/Bridge] Thread creation: ');
            return $this->error('Thread creation failed: ' . $e->getMessage(), 500);
        }

        if (!$thread) {
            return $this->error('Thread creation returned null', 500);
        }

        for ($i = 1, $n = count($posts); $i < $n; $i++) {
            $entry = $posts[$i];
            $author = $this->resolveAuthor($entry, $ghostUser);
            if (!$author) {
                continue;
            }
            try {
                $self = $this;
                \XF::asVisitor($author, function () use ($self, $thread, $entry) {
                    /** @var \XF\Service\Thread\Replier $replier */
                    $replier = $self->app()->service('XF:Thread\\Replier', $thread);
                    if (method_exists($replier, 'setIsAutomated')) {
                        $replier->setIsAutomated();
                    }
                    $replier->setMessage($self->renderPostBodyPublic($entry));
                    if ($replier->validate($errors)) {
                        $replier->save();
                    } else {
                        \XF::logError('[Abyss/Bridge] Reply validation failed: ' . implode('; ', $errors));
                    }
                });
            } catch (\Throwable $e) {
                \XF::logException($e, false, '[Abyss/Bridge] Reply: ');
            }
        }

        return $this->apiSuccess([
            'thread_id' => $thread->thread_id,
            'url' => $this->app()->router('public')->buildLink('canonical:threads', $thread),
        ]);
    }

    /**
     * @return \XF\Entity\User|null
     */
    private function resolveAuthor(array $entry, \XF\Entity\User $ghost)
    {
        $mode = $entry['mode'] ?? '';
        if ($mode === 'real') {
            $uid = isset($entry['xf_user_id']) ? (int)$entry['xf_user_id'] : 0;
            if ($uid > 0) {
                $u = $this->em()->find('XF:User', $uid);
                if ($u) {
                    return $u;
                }
            }
            return null;
        }
        return $ghost;
    }

    /**
     * Public alias because the closures passed to \XF::asVisitor execute with
     * outer-scope $this but PHP's protected-visibility check still applies.
     */
    public function renderPostBodyPublic(array $entry): string
    {
        return $this->renderPostBody($entry);
    }

    private function renderPostBody(array $entry): string
    {
        $bbcode = (string)($entry['bbcode'] ?? '');
        if (($entry['mode'] ?? '') === 'ghost') {
            $name = trim((string)($entry['display_name'] ?? 'Unknown'));
            $avatar = trim((string)($entry['avatar_url'] ?? ''));
            $abyssId = trim((string)($entry['abyss_user_id'] ?? ''));
            $headerLines = [];
            $headerLines[] = '[SIZE=2][I]Posted via Abyss as[/I] [B]' . $name . '[/B]'
                . ($abyssId !== '' ? ' (abyss:' . $abyssId . ')' : '') . '[/SIZE]';
            if ($avatar !== '') {
                $headerLines[] = '[IMG]' . $avatar . '[/IMG]';
            }
            $bbcode = implode("\n", $headerLines) . "\n\n" . $bbcode;
        }
        return $bbcode;
    }
}
