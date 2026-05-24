<?php

namespace Abyss\Bridge\Pub\Controller;

use Abyss\Bridge\Util\Jwt;
use XF\Mvc\ParameterBag;
use XF\Pub\Controller\AbstractController;

/**
 * Public controller for the Abyss link flow.
 *
 *   GET /abyss/link/start?nonce=N&return_url=R
 *     - Requires a logged-in XF user.
 *     - Signs a JWT proving the XF identity for nonce N.
 *     - Redirects to R?token=<jwt> (must be on the configured Abyss host).
 *
 *   GET /abyss/link/claim?token=<jwt>
 *     - Optional reverse direction: Abyss signs a JWT vouching for its user;
 *       XF verifies and could attach metadata to the XF account.
 *     - This addon ships a stub that just verifies the token and shows
 *       "claim received" — extend if you want to persist the link XF-side.
 */
class Link extends AbstractController
{
    public function actionStart(ParameterBag $params)
    {
        $visitor = \XF::visitor();
        if (!$visitor->user_id) {
            // Not logged in: bounce through XF's login, returning here.
            return $this->redirect(
                $this->buildLink('login', null, ['_xfRedirect' => $this->request->getRequestUri()])
            );
        }

        $nonce = (string)$this->filter('nonce', 'str');
        $returnUrl = (string)$this->filter('return_url', 'str');

        if ($nonce === '' || $returnUrl === '') {
            return $this->error(\XF::phrase('abyss_bridge_missing_nonce_or_return_url'));
        }

        $abyssBase = trim((string)$this->options()->abyssBridgeAbyssBaseUrl, '/');
        if ($abyssBase === '') {
            return $this->error(\XF::phrase('abyss_bridge_not_configured'));
        }

        if (!self::urlIsUnderHost($returnUrl, $abyssBase)) {
            return $this->error(\XF::phrase('abyss_bridge_return_url_not_allowed'));
        }

        $secret = (string)$this->options()->abyssBridgeSharedSecret;
        if ($secret === '') {
            return $this->error(\XF::phrase('abyss_bridge_not_configured'));
        }

        $now = time();
        $jwt = Jwt::sign([
            'iss' => 'xenforo',
            'aud' => 'abyss',
            'sub' => (string)$visitor->user_id,
            'abyss_link_nonce' => $nonce,
            'xf_username' => $visitor->username,
            'nbf' => $now - 5,
            'exp' => $now + 300,
        ], $secret);

        $sep = (strpos($returnUrl, '?') === false) ? '?' : '&';
        return $this->redirect($returnUrl . $sep . 'token=' . rawurlencode($jwt));
    }

    public function actionClaim(ParameterBag $params)
    {
        $token = (string)$this->filter('token', 'str');
        if ($token === '') {
            return $this->error(\XF::phrase('abyss_bridge_missing_token'));
        }
        $secret = (string)$this->options()->abyssBridgeSharedSecret;
        if ($secret === '') {
            return $this->error(\XF::phrase('abyss_bridge_not_configured'));
        }

        try {
            $claims = Jwt::verify($token, $secret, ['iss' => 'abyss', 'aud' => 'xenforo']);
        } catch (\Throwable $e) {
            return $this->error(\XF::phrase('abyss_bridge_invalid_token'));
        }

        $view = $this->view('Abyss\\Bridge:Claim\\Confirm', '', [
            'abyssUserId' => $claims['sub'] ?? '',
            'nonce' => $claims['claim_nonce'] ?? '',
        ]);
        return $view;
    }

    private static function urlIsUnderHost(string $candidate, string $baseUrl): bool
    {
        $base = parse_url($baseUrl);
        $cand = parse_url($candidate);
        if (!$base || !$cand || empty($base['host']) || empty($cand['host'])) {
            return false;
        }
        if (strcasecmp($base['host'], $cand['host']) !== 0) {
            return false;
        }
        $baseScheme = strtolower($base['scheme'] ?? '');
        $candScheme = strtolower($cand['scheme'] ?? '');
        if ($baseScheme !== '' && $candScheme !== '' && $baseScheme !== $candScheme) {
            return false;
        }
        if (!empty($base['port']) && !empty($cand['port']) && (int)$base['port'] !== (int)$cand['port']) {
            return false;
        }
        return true;
    }
}
