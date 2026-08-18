<?php
/**
 * Minimal Google Sheets API v4 client using a service account.
 *
 * Avoids the Composer / google-api-php-client dependency: it signs its own
 * OAuth2 JWT with the service account private key (RS256 via openssl) and talks
 * to the REST API with cURL. Requires the openssl and curl PHP extensions.
 */
class GoogleSheetsService {
    private string $spreadsheetId;
    private array $creds;
    private ?string $token = null;

    public function __construct(string $credentialsPath, string $spreadsheetId) {
        if (!$credentialsPath || !file_exists($credentialsPath)) {
            throw new RuntimeException('Google credentials file not found');
        }
        $json = json_decode(file_get_contents($credentialsPath), true);
        if (!isset($json['client_email'], $json['private_key'])) {
            throw new RuntimeException('Invalid Google credentials file');
        }
        $this->creds = $json;
        $this->spreadsheetId = $spreadsheetId;
    }

    private static function b64url(string $data): string {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /** Fetch (and cache) an OAuth2 access token via the JWT bearer flow. */
    private function accessToken(): string {
        if ($this->token) return $this->token;

        $now = time();
        $header = ['alg' => 'RS256', 'typ' => 'JWT'];
        $claim = [
            'iss'   => $this->creds['client_email'],
            'scope' => 'https://www.googleapis.com/auth/spreadsheets',
            'aud'   => 'https://oauth2.googleapis.com/token',
            'iat'   => $now,
            'exp'   => $now + 3600,
        ];
        $signingInput = self::b64url(json_encode($header)) . '.' . self::b64url(json_encode($claim));

        $signature = '';
        if (!openssl_sign($signingInput, $signature, $this->creds['private_key'], 'sha256WithRSAEncryption')) {
            throw new RuntimeException('Failed to sign JWT');
        }
        $jwt = $signingInput . '.' . self::b64url($signature);

        $resp = $this->httpPost(
            'https://oauth2.googleapis.com/token',
            http_build_query([
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion'  => $jwt,
            ]),
            ['Content-Type: application/x-www-form-urlencoded']
        );
        $data = json_decode($resp, true);
        if (!isset($data['access_token'])) {
            throw new RuntimeException('Token request failed: ' . $resp);
        }
        return $this->token = $data['access_token'];
    }

    private function authHeaders(): array {
        return ['Authorization: Bearer ' . $this->accessToken()];
    }

    private function base(): string {
        return 'https://sheets.googleapis.com/v4/spreadsheets/' . rawurlencode($this->spreadsheetId);
    }

    /** GET a range; returns the `values` 2-D array (possibly empty). */
    public function readRange(string $range): array {
        $url = $this->base() . '/values/' . rawurlencode($range);
        $resp = $this->httpGet($url, $this->authHeaders());
        $data = json_decode($resp, true);
        return $data['values'] ?? [];
    }

    /** PUT values starting at a top-left cell (RAW input). */
    public function writeRange(string $range, array $values): void {
        $url = $this->base() . '/values/' . rawurlencode($range)
             . '?valueInputOption=RAW';
        $this->httpPut($url, json_encode(['values' => $values]),
            array_merge($this->authHeaders(), ['Content-Type: application/json']));
    }

    public function clearRange(string $range): void {
        $url = $this->base() . '/values/' . rawurlencode($range) . ':clear';
        $this->httpPost($url, '{}',
            array_merge($this->authHeaders(), ['Content-Type: application/json']));
    }

    /** Create a tab if it does not already exist (used by setup). */
    public function ensureSheet(string $title): void {
        $meta = json_decode($this->httpGet($this->base(), $this->authHeaders()), true);
        foreach ($meta['sheets'] ?? [] as $s) {
            if (($s['properties']['title'] ?? '') === $title) return;
        }
        $body = json_encode(['requests' => [['addSheet' => ['properties' => ['title' => $title]]]]]);
        $this->httpPost($this->base() . ':batchUpdate', $body,
            array_merge($this->authHeaders(), ['Content-Type: application/json']));
    }

    // ── HTTP helpers ──────────────────────────────────────────────
    private function httpGet(string $url, array $headers): string {
        return $this->request('GET', $url, null, $headers);
    }
    private function httpPost(string $url, string $body, array $headers): string {
        return $this->request('POST', $url, $body, $headers);
    }
    private function httpPut(string $url, string $body, array $headers): string {
        return $this->request('PUT', $url, $body, $headers);
    }
    private function request(string $method, string $url, ?string $body, array $headers): string {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_TIMEOUT        => 30,
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $resp = curl_exec($ch);
        if ($resp === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new RuntimeException("HTTP $method failed: $err");
        }
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code >= 400) {
            throw new RuntimeException("HTTP $method $url returned $code: $resp");
        }
        return $resp;
    }
}
