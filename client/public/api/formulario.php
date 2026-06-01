/**client/public/api/formulario.php */


<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$config = cushuro_get_config();
cushuro_handle_preflight($config);
$origin = cushuro_ensure_allowed_origin($config);
cushuro_require_method('POST', $origin, $config);
cushuro_rate_limit('/api/formulario', $origin, $config);

$payload = cushuro_get_request_payload();
$validation = cushuro_validate_form_payload($payload);

if (!empty($validation['errors'])) {
    cushuro_json_response(
        400,
        ['errors' => $validation['errors']],
        $origin,
        $config
    );
}

$formData = $validation['data'];
cushuro_verify_recaptcha((string) $formData['recaptcha_token'], $origin, $config);
cushuro_send_form_email($formData, $origin, $config);

cushuro_json_response(
    200,
    [
        'ok' => true,
        'redirectTo' => $config['redirect_to'] ?? '/formulario',
    ],
    $origin,
    $config
);
