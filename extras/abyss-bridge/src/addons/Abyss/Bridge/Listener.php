<?php

namespace Abyss\Bridge;

/**
 * Mirrors post create / update / delete events from XenForo to the configured
 * Abyss instance via HMAC-signed webhook calls.
 *
 * Inserts and updates both arrive through entity_post_save; isInsert() is only
 * reliable before save_, so we capture it in entity_pre_save keyed by the
 * entity's object id and consume it in entity_post_save.
 */
class Listener
{
    /** @var array<int,bool> oid => was-insert flag captured in entity_pre_save */
    private static $pendingInserts = [];

    public static function entityPreSave(\XF\Mvc\Entity\Entity $entity): void
    {
        if ($entity instanceof \XF\Entity\Post) {
            self::$pendingInserts[spl_object_id($entity)] = $entity->isInsert();
        }
    }

    public static function entityPostSave(\XF\Mvc\Entity\Entity $entity): void
    {
        if (!$entity instanceof \XF\Entity\Post) {
            return;
        }

        $oid = spl_object_id($entity);
        $wasInsert = array_key_exists($oid, self::$pendingInserts)
            ? self::$pendingInserts[$oid]
            : !$entity->getExistingValue('post_id');
        unset(self::$pendingInserts[$oid]);

        // Skip drafts, moderation queue, deleted posts — only published content mirrors.
        if (($entity->message_state ?? 'visible') !== 'visible') {
            return;
        }

        self::dispatchSave($wasInsert ? 'post.created' : 'post.updated', $entity);
    }

    public static function entityPostDelete(\XF\Mvc\Entity\Entity $entity): void
    {
        if (!$entity instanceof \XF\Entity\Post) {
            return;
        }
        self::dispatchDelete((int)$entity->post_id);
    }

    private static function dispatchSave(string $eventName, \XF\Entity\Post $post): void
    {
        [$abyssBase, $secret] = self::config();
        if ($abyssBase === '' || $secret === '') {
            return;
        }

        /** @var \XF\Entity\Thread|null $thread */
        $thread = $post->Thread;
        if (!$thread) {
            return;
        }
        /** @var \XF\Entity\User|null $user */
        $user = $post->User;

        $router = \XF::app()->router('public');
        $avatar = '';
        if ($user) {
            $avatar = $router->buildLink('canonical:full:avatar', $user, ['s' => 'l']);
        }

        $isOp = ((int)$post->post_id === (int)$thread->first_post_id);
        $editStamp = (int)($post->last_edit_date ?: $post->post_date);

        $payload = [
            'event' => $eventName,
            'event_id' => $eventName . ':' . (int)$post->post_id . ':' . ($eventName === 'post.updated' ? $editStamp : (int)$post->post_date),
            'data' => [
                'xf_post_id'    => (int)$post->post_id,
                'xf_thread_id'  => (int)$post->thread_id,
                'node_id'       => (int)$thread->node_id,
                'xf_user_id'    => (int)$post->user_id,
                'username'      => $user ? (string)$user->username : (string)$post->username,
                'avatar_url'    => $avatar,
                'first_post_id' => (int)$thread->first_post_id,
                'bbcode'        => (string)$post->message,
                'title'         => $isOp ? (string)$thread->title : null,
                'url'           => $router->buildLink('canonical:full:posts', $post),
                'created_at'    => (int)$post->post_date,
            ],
        ];

        self::send($abyssBase, $secret, $payload);
    }

    private static function dispatchDelete(int $postId): void
    {
        [$abyssBase, $secret] = self::config();
        if ($abyssBase === '' || $secret === '' || $postId <= 0) {
            return;
        }
        self::send($abyssBase, $secret, [
            'event' => 'post.deleted',
            'event_id' => 'post.deleted:' . $postId,
            'data' => ['xf_post_id' => $postId],
        ]);
    }

    /** @return array{0:string,1:string} */
    private static function config(): array
    {
        $options = \XF::app()->options();
        $abyssBase = trim((string)$options->abyssBridgeAbyssBaseUrl, '/');
        $secret = (string)$options->abyssBridgeSharedSecret;
        return [$abyssBase, $secret];
    }

    private static function send(string $abyssBase, string $secret, array $payload): void
    {
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($body === false) {
            return;
        }
        $sig = 'sha256=' . hash_hmac('sha256', $body, $secret);
        try {
            $client = \XF::app()->http()->client();
            $client->post($abyssBase . '/api/xenforo/webhook', [
                'body' => $body,
                'headers' => [
                    'Content-Type' => 'application/json',
                    'X-Abyss-Signature' => $sig,
                ],
                'http_errors' => false,
                'timeout' => 3,
                'connect_timeout' => 2,
            ]);
        } catch (\Throwable $e) {
            \XF::logException($e, false, '[Abyss/Bridge] Webhook dispatch: ');
        }
    }
}
