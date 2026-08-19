<?php

namespace Abyss\Bridge\Pub\Controller;

use Abyss\Bridge\Util\Jwt;
use XF\Mvc\ParameterBag;
use XF\Pub\Controller\AbstractController;

/**
 * Embeddable shoutbox iframe target.
 *
 *   GET /abyss-shoutbox
 *     - Forum admins embed this same-origin route in any template:
 *         <iframe src="{{ link('abyss-shoutbox') }}" class="abyssShoutbox"></iframe>
 *     - For a logged-in visitor: mints a short-lived HS256 JWT proving the XF
 *       identity (token_use=shoutbox) and redirects the iframe to the Abyss
 *       widget at {abyssBase}/widget.html#token=<jwt>.
 *     - For a guest: redirects to {abyssBase}/widget.html with no token; the
 *       widget renders its own "log in to chat" placeholder.
 *
 * The token rides in the URL fragment so it is never sent to a server or
 * written to access logs. The widget reads it from location.hash and exchanges
 * it for an Abyss session via POST /api/xenforo/shoutbox/session.
 */
class Shoutbox extends AbstractController
{
    public function actionIndex(ParameterBag $params)
    {
        $abyssBase = trim((string)$this->options()->abyssBridgeAbyssBaseUrl, '/');
        if ($abyssBase === '') {
            return $this->error(\XF::phrase('abyss_bridge_not_configured'));
        }

        $widgetUrl = $abyssBase . '/widget.html';
        $visitor = \XF::visitor();

        // Guests: hand off to the widget's own placeholder.
        if (!$visitor->user_id) {
            return $this->redirect($widgetUrl);
        }

        $secret = (string)$this->options()->abyssBridgeSharedSecret;
        if ($secret === '') {
            return $this->error(\XF::phrase('abyss_bridge_not_configured'));
        }

        $now = time();
        $jwt = Jwt::sign([
            'iss' => 'xenforo',
            'aud' => 'abyss',
            'token_use' => 'shoutbox',
            'sub' => (string)$visitor->user_id,
            'xf_username' => $visitor->username,
            'display_name' => $visitor->username,
            'avatar_url' => $visitor->getAvatarUrl('m', null, true),
            'xf_is_banned' => $visitor->is_banned ? 'true' : 'false',
            'nbf' => $now - 5,
            'exp' => $now + 300,
        ], $secret);

        return $this->redirect($widgetUrl . '#token=' . rawurlencode($jwt));
    }
}
