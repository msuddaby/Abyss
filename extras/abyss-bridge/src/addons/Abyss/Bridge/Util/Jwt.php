<?php

namespace Abyss\Bridge\Util;

/**
 * Minimal HS256 JWT helper. No external dependencies — uses hash_hmac().
 * Matches the C# bridge's expected JWT shape (issuer, audience, sub, exp, nbf).
 */
class Jwt
{
    public static function sign(array $payload, string $secret): string
    {
        $header = ['alg' => 'HS256', 'typ' => 'JWT'];
        $h = self::b64UrlEncode(json_encode($header, JSON_UNESCAPED_SLASHES));
        $p = self::b64UrlEncode(json_encode($payload, JSON_UNESCAPED_SLASHES));
        $sig = hash_hmac('sha256', $h . '.' . $p, $secret, true);
        return $h . '.' . $p . '.' . self::b64UrlEncode($sig);
    }

    /**
     * @throws \RuntimeException on any validation failure (signature, expiry, issuer/audience mismatch)
     */
    public static function verify(string $token, string $secret, array $expect = []): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new \RuntimeException('Malformed token');
        }
        [$h, $p, $s] = $parts;

        $header = json_decode(self::b64UrlDecode($h), true);
        if (!is_array($header) || ($header['alg'] ?? '') !== 'HS256') {
            throw new \RuntimeException('Unsupported algorithm');
        }

        $expectedSig = hash_hmac('sha256', $h . '.' . $p, $secret, true);
        $sig = self::b64UrlDecode($s);
        if (!hash_equals($expectedSig, $sig)) {
            throw new \RuntimeException('Bad signature');
        }

        $claims = json_decode(self::b64UrlDecode($p), true);
        if (!is_array($claims)) {
            throw new \RuntimeException('Bad payload');
        }

        $now = time();
        $skew = 30;
        if (isset($claims['nbf']) && is_numeric($claims['nbf']) && $now + $skew < (int)$claims['nbf']) {
            throw new \RuntimeException('Token not yet valid');
        }
        if (isset($claims['exp']) && is_numeric($claims['exp']) && $now - $skew > (int)$claims['exp']) {
            throw new \RuntimeException('Token expired');
        }

        if (isset($expect['iss']) && ($claims['iss'] ?? null) !== $expect['iss']) {
            throw new \RuntimeException('Issuer mismatch');
        }
        if (isset($expect['aud']) && ($claims['aud'] ?? null) !== $expect['aud']) {
            throw new \RuntimeException('Audience mismatch');
        }

        return $claims;
    }

    private static function b64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function b64UrlDecode(string $data): string
    {
        $remainder = strlen($data) % 4;
        if ($remainder) {
            $data .= str_repeat('=', 4 - $remainder);
        }
        $decoded = base64_decode(strtr($data, '-_', '+/'), true);
        if ($decoded === false) {
            throw new \RuntimeException('Bad base64');
        }
        return $decoded;
    }
}
