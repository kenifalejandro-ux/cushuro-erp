/**client/public/api/bootstrap.php */

<?php

declare(strict_types=1);

function cushuro_env(string $name, ?string $default = null): ?string
{
    $value = getenv($name);
    if ($value === false || $value === null || $value === '') {
        $value = $_SERVER[$name] ?? $_ENV[$name] ?? null;
    }

    if (!is_string($value)) {
        return $default;
    }

    $trimmed = trim($value);
    return $trimmed !== '' ? $trimmed : $default;
}

function cushuro_length(string $value): int
{
    return function_exists('mb_strlen') ? mb_strlen($value, 'UTF-8') : strlen($value);
}

function cushuro_sanitize_single_line(string $value): string
{
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? $value;
    $value = preg_replace('/\s+/u', ' ', $value) ?? $value;
    return trim($value);
}

function cushuro_sanitize_multiline(string $value): string
{
    $value = str_replace(["\r\n", "\r"], "\n", $value);
    $value = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/u', '', $value) ?? $value;
    return trim($value);
}

function cushuro_escape_html(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function cushuro_format_multiline_html(string $value): string
{
    return nl2br(cushuro_escape_html($value), false);
}

function cushuro_mask_email(string $value): string
{
    $parts = explode('@', $value, 2);
    if (count($parts) !== 2) {
        return $value;
    }

    [$name, $domain] = $parts;
    $visible = substr($name, 0, 2);
    $masked = str_repeat('*', max(1, strlen($name) - strlen($visible)));
    return $visible . $masked . '@' . $domain;
}

function cushuro_safe_header_value(string $value): string
{
    return trim(str_replace(["\r", "\n"], '', $value));
}

function cushuro_encode_mail_header(string $value): string
{
    $clean = cushuro_safe_header_value($value);
    if (function_exists('mb_encode_mimeheader')) {
        return mb_encode_mimeheader($clean, 'UTF-8', 'B', "\r\n");
    }

    return $clean;
}

function cushuro_get_request_id(): string
{
    static $requestId = null;

    if (is_string($requestId) && $requestId !== '') {
        return $requestId;
    }

    $headerValue = $_SERVER['HTTP_X_REQUEST_ID'] ?? '';
    if (is_string($headerValue) && trim($headerValue) !== '') {
        $requestId = cushuro_safe_header_value($headerValue);
        return $requestId;
    }

    try {
        $requestId = bin2hex(random_bytes(16));
    } catch (Throwable $error) {
        $requestId = uniqid('req_', true);
    }

    return $requestId;
}

function cushuro_get_client_ip(): string
{
    $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if (is_string($forwarded) && trim($forwarded) !== '') {
        $parts = explode(',', $forwarded);
        $candidate = trim($parts[0]);
        if ($candidate !== '') {
            return $candidate;
        }
    }

    $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
    return is_string($remoteAddr) && $remoteAddr !== '' ? $remoteAddr : '0.0.0.0';
}

function cushuro_normalize_origins($value): array
{
    if (is_string($value)) {
        $value = array_map('trim', explode(',', $value));
    }

    if (!is_array($value)) {
        return [];
    }

    $origins = [];
    foreach ($value as $origin) {
        if (!is_string($origin)) {
            continue;
        }

        $clean = trim($origin);
        if ($clean !== '') {
            $origins[] = $clean;
        }
    }

    return array_values(array_unique($origins));
}

function cushuro_get_config(): array
{
    static $config = null;

    if (is_array($config)) {
        return $config;
    }

    $baseConfig = [
        'contact_destination' => cushuro_env('CONTACT_EMAIL_TO')
            ?? cushuro_env('FORM_EMAIL_TO')
            ?? cushuro_env('EMAIL_USER')
            ?? '',
        'email_from' => cushuro_env('EMAIL_FROM')
            ?? cushuro_env('EMAIL_USER')
            ?? '',
        'email_from_name' => cushuro_env('EMAIL_FROM_NAME', 'Formulario Web') ?? 'Formulario Web',
        'recaptcha_site_key' => cushuro_env('RECAPTCHA_SITE_KEY', '') ?? '',
        'recaptcha_secret_key' => cushuro_env('RECAPTCHA_SECRET_KEY', '') ?? '',
        'recaptcha_expected_action' => cushuro_env('RECAPTCHA_EXPECTED_ACTION', 'submit') ?? 'submit',
        'recaptcha_min_score' => (float) (cushuro_env('RECAPTCHA_MIN_SCORE', '0.5') ?? '0.5'),
        'allowed_origins' => cushuro_normalize_origins(cushuro_env('ALLOWED_ORIGINS', '') ?? ''),
        'rate_limit_window_ms' => (int) (cushuro_env('RATE_LIMIT_WINDOW_MS', '60000') ?? '60000'),
        'rate_limit_max_requests' => (int) (cushuro_env('RATE_LIMIT_MAX_REQUESTS', '5') ?? '5'),
        'redirect_to' => cushuro_env('FORM_REDIRECT_TO', '/formulario') ?? '/formulario',
        'log_file' => cushuro_env('FORM_LOG_FILE', '') ?? '',
    ];

    $configPath = __DIR__ . '/config.php';
    if (is_file($configPath)) {
        $customConfig = require $configPath;
        if (is_array($customConfig)) {
            $baseConfig = array_replace($baseConfig, $customConfig);
        }
    }

    $localConfigPath = __DIR__ . '/config.local.php';
    if (is_file($localConfigPath)) {
        $localConfig = require $localConfigPath;
        if (is_array($localConfig)) {
            $baseConfig = array_replace($baseConfig, $localConfig);
        }
    }

    $baseConfig['allowed_origins'] = cushuro_normalize_origins($baseConfig['allowed_origins'] ?? []);
    $baseConfig['rate_limit_window_ms'] = max(1000, (int) ($baseConfig['rate_limit_window_ms'] ?? 60000));
    $baseConfig['rate_limit_max_requests'] = max(1, (int) ($baseConfig['rate_limit_max_requests'] ?? 5));
    $baseConfig['redirect_to'] = is_string($baseConfig['redirect_to'] ?? null)
        ? trim((string) $baseConfig['redirect_to']) ?: '/formulario'
        : '/formulario';
    $baseConfig['log_file'] = is_string($baseConfig['log_file'] ?? null)
        ? trim((string) $baseConfig['log_file'])
        : '';

    $config = $baseConfig;
    return $config;
}

function cushuro_get_origin(): ?string
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (!is_string($origin)) {
        return null;
    }

    $origin = trim($origin);
    return $origin !== '' ? $origin : null;
}

function cushuro_current_host(): string
{
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if (!is_string($host)) {
        return '';
    }

    return strtolower(trim(preg_replace('/:\d+$/', '', $host) ?? $host));
}

function cushuro_is_allowed_origin(?string $origin, array $config): bool
{
    if ($origin === null || $origin === '') {
        return true;
    }

    $host = parse_url($origin, PHP_URL_HOST);
    if (!is_string($host) || trim($host) === '') {
        return false;
    }

    $host = strtolower(trim($host));
    if ($host === 'localhost' || $host === '127.0.0.1') {
        return true;
    }

    if ($host === cushuro_current_host()) {
        return true;
    }

    foreach ($config['allowed_origins'] as $allowedOrigin) {
        if (strcasecmp($origin, $allowedOrigin) === 0) {
            return true;
        }
    }

    return false;
}

function cushuro_apply_common_headers(?string $origin, array $config): void
{
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store');
    header('X-Request-Id: ' . cushuro_get_request_id());

    if ($origin !== null && cushuro_is_allowed_origin($origin, $config)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    }

    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With, X-Request-Id');
}

function cushuro_json_response(int $status, array $payload, ?string $origin = null, ?array $config = null): void
{
    $config = $config ?? cushuro_get_config();
    cushuro_apply_common_headers($origin, $config);
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function cushuro_handle_preflight(array $config): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'OPTIONS') {
        return;
    }

    $origin = cushuro_get_origin();
    if (!cushuro_is_allowed_origin($origin, $config)) {
        cushuro_json_response(403, ['message' => 'Origin no permitido.'], $origin, $config);
    }

    cushuro_apply_common_headers($origin, $config);
    http_response_code(204);
    exit;
}

function cushuro_ensure_allowed_origin(array $config): ?string
{
    $origin = cushuro_get_origin();
    if (!cushuro_is_allowed_origin($origin, $config)) {
        cushuro_json_response(403, ['message' => 'Origin no permitido.'], $origin, $config);
    }

    return $origin;
}

function cushuro_require_method(string $expectedMethod, ?string $origin, array $config): void
{
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method !== strtoupper($expectedMethod)) {
        cushuro_json_response(405, ['message' => 'Metodo no permitido.'], $origin, $config);
    }
}

function cushuro_get_request_payload(): array
{
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (is_string($contentType) && stripos($contentType, 'application/json') !== false) {
        $rawBody = file_get_contents('php://input');
        if (!is_string($rawBody) || trim($rawBody) === '') {
            return [];
        }

        $decoded = json_decode($rawBody, true);
        return is_array($decoded) ? $decoded : [];
    }

    return is_array($_POST) ? $_POST : [];
}

function cushuro_validate_form_payload(array $payload): array
{
    $nombre = cushuro_sanitize_single_line((string) ($payload['Nombre'] ?? ''));
    $empresa = cushuro_sanitize_single_line((string) ($payload['Empresa'] ?? ''));
    $correo = strtolower(cushuro_sanitize_single_line((string) ($payload['Correo'] ?? '')));
    $telefono = cushuro_sanitize_single_line((string) ($payload['Telefono'] ?? ''));
    $producto = cushuro_sanitize_single_line((string) ($payload['Producto'] ?? ($payload['Servicio'] ?? '')));
    $mensaje = cushuro_sanitize_multiline((string) ($payload['Mensaje'] ?? ''));
    $token = cushuro_sanitize_single_line((string) ($payload['recaptcha_token'] ?? ''));
    $website = cushuro_sanitize_single_line((string) ($payload['website'] ?? ''));

    $errors = [];

    if (cushuro_length($nombre) < 2) {
        $errors[] = ['field' => 'Nombre', 'message' => 'El nombre es muy corto'];
    } elseif (cushuro_length($nombre) > 120) {
        $errors[] = ['field' => 'Nombre', 'message' => 'El nombre es muy largo'];
    }

    if (cushuro_length($empresa) < 2) {
        $errors[] = ['field' => 'Empresa', 'message' => 'La empresa es obligatoria'];
    } elseif (cushuro_length($empresa) > 160) {
        $errors[] = ['field' => 'Empresa', 'message' => 'La empresa es muy larga'];
    }

    if ($correo === '' || !filter_var($correo, FILTER_VALIDATE_EMAIL)) {
        $errors[] = ['field' => 'Correo', 'message' => 'Correo inválido'];
    } elseif (cushuro_length($correo) > 160) {
        $errors[] = ['field' => 'Correo', 'message' => 'Correo demasiado largo'];
    }

    if (cushuro_length($telefono) < 7) {
        $errors[] = ['field' => 'Telefono', 'message' => 'El telefono es muy corto'];
    } elseif (cushuro_length($telefono) > 30) {
        $errors[] = ['field' => 'Telefono', 'message' => 'El telefono es muy largo'];
    } elseif (!preg_match('/^[0-9+()\-\s.]+$/', $telefono)) {
        $errors[] = ['field' => 'Telefono', 'message' => 'Telefono inválido'];
    }

    if (cushuro_length($producto) < 2) {
        $errors[] = ['field' => 'Producto', 'message' => 'El producto es obligatorio'];
    }

    if (cushuro_length($mensaje) < 10) {
        $errors[] = ['field' => 'Mensaje', 'message' => 'El mensaje es muy corto'];
    } elseif (cushuro_length($mensaje) > 3000) {
        $errors[] = ['field' => 'Mensaje', 'message' => 'El mensaje es muy largo'];
    }

    if (cushuro_length($token) < 10) {
        $errors[] = ['field' => 'recaptcha_token', 'message' => 'Token de reCAPTCHA faltante'];
    } elseif (cushuro_length($token) > 4096) {
        $errors[] = ['field' => 'recaptcha_token', 'message' => 'Token de reCAPTCHA inválido'];
    }

    if ($website !== '') {
        $errors[] = ['field' => 'website', 'message' => 'Actividad sospechosa detectada'];
    }

    return [
        'errors' => $errors,
        'data' => [
            'Nombre' => $nombre,
            'Empresa' => $empresa,
            'Correo' => $correo,
            'Telefono' => $telefono,
            'Producto' => $producto,
            'Mensaje' => $mensaje,
            'recaptcha_token' => $token,
            'website' => $website,
        ],
    ];
}

function cushuro_log(array $context): void
{
    $config = cushuro_get_config();
    if (($config['log_file'] ?? '') === '') {
        return;
    }

    $line = json_encode(
        ['timestamp' => date('c')] + $context,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
    );

    if (!is_string($line)) {
        return;
    }

    @file_put_contents($config['log_file'], $line . PHP_EOL, FILE_APPEND | LOCK_EX);
}

function cushuro_rate_limit(string $path, ?string $origin, array $config): void
{
    $windowSeconds = (int) ceil(((int) $config['rate_limit_window_ms']) / 1000);
    $maxRequests = (int) $config['rate_limit_max_requests'];
    $ip = cushuro_get_client_ip();
    $key = md5('form:' . $path . ':' . $ip);
    $filePath = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'cushuro-rate-' . $key . '.json';

    $handle = @fopen($filePath, 'c+');
    if ($handle === false) {
        return;
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            return;
        }

        $rawState = stream_get_contents($handle);
        $state = is_string($rawState) ? json_decode($rawState, true) : null;
        $now = time();

        if (!is_array($state) || !isset($state['start'], $state['count'])) {
            $state = ['start' => $now, 'count' => 0];
        }

        if (($now - (int) $state['start']) >= $windowSeconds) {
            $state = ['start' => $now, 'count' => 0];
        }

        if ((int) $state['count'] >= $maxRequests) {
            cushuro_log([
                'level' => 'warning',
                'event' => 'rate_limit_blocked',
                'ip' => $ip,
                'path' => $path,
            ]);
            cushuro_json_response(
                429,
                ['message' => 'Demasiados intentos. Espera un momento antes de volver a enviar.'],
                $origin,
                $config
            );
        }

        $state['count'] = (int) $state['count'] + 1;

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state));
        fflush($handle);
        flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

function cushuro_http_post_form(string $url, array $fields): array
{
    $payload = http_build_query($fields);

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        if ($ch === false) {
            return ['status' => 0, 'body' => ''];
        }

        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        ]);

        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        return [
            'status' => $status,
            'body' => is_string($body) ? $body : '',
        ];
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
            'content' => $payload,
            'timeout' => 5,
            'ignore_errors' => true,
        ],
    ]);

    $body = @file_get_contents($url, false, $context);
    $headers = $http_response_header ?? [];
    $status = 0;

    if (isset($headers[0]) && preg_match('/\s(\d{3})\s/', $headers[0], $matches)) {
        $status = (int) $matches[1];
    }

    return [
        'status' => $status,
        'body' => is_string($body) ? $body : '',
    ];
}

function cushuro_verify_recaptcha(string $token, ?string $origin, array $config): array
{
    if (($config['recaptcha_secret_key'] ?? '') === '') {
        cushuro_json_response(
            500,
            ['message' => 'La validacion anti-spam no esta configurada en el servidor.'],
            $origin,
            $config
        );
    }

    $response = cushuro_http_post_form(
        'https://www.google.com/recaptcha/api/siteverify',
        [
            'secret' => $config['recaptcha_secret_key'],
            'response' => $token,
            'remoteip' => cushuro_get_client_ip(),
        ]
    );

    if (($response['status'] ?? 0) !== 200) {
        cushuro_log([
            'level' => 'error',
            'event' => 'recaptcha_unexpected_status',
            'status' => $response['status'] ?? 0,
        ]);
        cushuro_json_response(
            502,
            ['message' => 'No se pudo validar la proteccion anti-spam.'],
            $origin,
            $config
        );
    }

    $result = json_decode((string) ($response['body'] ?? ''), true);
    if (!is_array($result)) {
        cushuro_json_response(
            502,
            ['message' => 'No se pudo completar la verificacion anti-spam.'],
            $origin,
            $config
        );
    }

    $action = $result['action'] ?? '';
    $score = $result['score'] ?? null;
    $actionMatches = ($config['recaptcha_expected_action'] ?? '') === ''
        || $action === ''
        || $action === $config['recaptcha_expected_action'];
    $scoreMatches = !is_numeric($score) || (float) $score >= (float) ($config['recaptcha_min_score'] ?? 0.5);

    if (empty($result['success']) || !$actionMatches || !$scoreMatches) {
        cushuro_log([
            'level' => 'warning',
            'event' => 'recaptcha_rejected',
            'score' => $score,
            'action' => $action,
            'hostname' => $result['hostname'] ?? null,
            'error_codes' => $result['error-codes'] ?? [],
        ]);
        cushuro_json_response(
            400,
            [
                'errors' => [[
                    'field' => 'recaptcha_token',
                    'message' => 'Fallo la verificacion anti-spam. Intenta nuevamente.',
                ]],
            ],
            $origin,
            $config
        );
    }

    return $result;
}

function cushuro_build_mail_content(array $formData): array
{
    $safeData = [
        'Nombre' => cushuro_escape_html($formData['Nombre']),
        'Empresa' => cushuro_escape_html($formData['Empresa']),
        'Correo' => cushuro_escape_html($formData['Correo']),
        'Telefono' => cushuro_escape_html($formData['Telefono']),
        'Producto' => cushuro_escape_html($formData['Producto']),
        'Mensaje' => cushuro_format_multiline_html($formData['Mensaje']),
    ];

    $text = implode("\n", [
        'Nueva consulta minera recibida',
        '',
        'Nombre: ' . $formData['Nombre'],
        'Empresa: ' . $formData['Empresa'],
        'Correo: ' . $formData['Correo'],
        'Telefono: ' . $formData['Telefono'],
        'Producto o servicio: ' . $formData['Producto'],
        '',
        'Mensaje:',
        $formData['Mensaje'],
    ]);

    $html = '
    <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">Nueva consulta minera recibida</h2>
      <table cellpadding="8" cellspacing="0" border="0" style="border-collapse: collapse;">
        <tr><td><strong>Nombre</strong></td><td>' . $safeData['Nombre'] . '</td></tr>
        <tr><td><strong>Empresa</strong></td><td>' . $safeData['Empresa'] . '</td></tr>
        <tr><td><strong>Correo</strong></td><td>' . $safeData['Correo'] . '</td></tr>
        <tr><td><strong>Telefono</strong></td><td>' . $safeData['Telefono'] . '</td></tr>
        <tr><td><strong>Producto o servicio</strong></td><td>' . $safeData['Producto'] . '</td></tr>
      </table>
      <div style="margin-top: 20px;">
        <strong>Mensaje</strong>
        <p style="margin-top: 8px;">' . $safeData['Mensaje'] . '</p>
      </div>
    </div>';

    return ['text' => $text, 'html' => $html];
}

function cushuro_send_form_email(array $formData, ?string $origin, array $config): void
{
    $to = cushuro_safe_header_value((string) ($config['contact_destination'] ?? ''));
    $from = cushuro_safe_header_value((string) ($config['email_from'] ?? ''));
    $fromName = cushuro_safe_header_value((string) ($config['email_from_name'] ?? 'Formulario Web'));

    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL) || !filter_var($from, FILTER_VALIDATE_EMAIL)) {
        cushuro_json_response(
            500,
            ['message' => 'El servicio de correo no esta configurado correctamente.'],
            $origin,
            $config
        );
    }

    $content = cushuro_build_mail_content($formData);
    $subjectRaw = substr('Nueva consulta minera - ' . $formData['Producto'], 0, 180);
    $subject = cushuro_encode_mail_header($subjectRaw);
    $boundary = 'cushuro_' . md5(uniqid((string) mt_rand(), true));

    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'From: ' . cushuro_encode_mail_header($fromName) . ' <' . $from . '>',
        'Reply-To: ' . cushuro_safe_header_value($formData['Correo']),
        'X-Request-Id: ' . cushuro_get_request_id(),
    ];

    $message = '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: 8bit\r\n\r\n"
        . $content['text'] . "\r\n\r\n"
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: 8bit\r\n\r\n"
        . $content['html'] . "\r\n\r\n"
        . '--' . $boundary . "--\r\n";

    cushuro_log([
        'level' => 'info',
        'event' => 'form_ready_to_send',
        'ip' => cushuro_get_client_ip(),
        'company' => $formData['Empresa'],
        'product' => $formData['Producto'],
        'email' => cushuro_mask_email($formData['Correo']),
    ]);

    $sent = @mail($to, $subject, $message, implode("\r\n", $headers));

    if (!$sent) {
        cushuro_log([
            'level' => 'error',
            'event' => 'mail_send_failed',
            'to' => $to,
        ]);
        cushuro_json_response(
            500,
            ['message' => 'No se pudo enviar el formulario.'],
            $origin,
            $config
        );
    }

    cushuro_log([
        'level' => 'info',
        'event' => 'form_sent',
        'to' => $to,
    ]);
}
