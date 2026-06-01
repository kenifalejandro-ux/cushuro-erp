/**client/public/api/recaptcha.php */


<?php

declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

$config = cushuro_get_config();
cushuro_handle_preflight($config);
$origin = cushuro_ensure_allowed_origin($config);
cushuro_require_method('GET', $origin, $config);

if (($config['recaptcha_site_key'] ?? '') === '') {
    cushuro_json_response(
        500,
        ['message' => 'RECAPTCHA_SITE_KEY no esta configurado en el servidor.'],
        $origin,
        $config
    );
}

cushuro_json_response(
    200,
    ['siteKey' => $config['recaptcha_site_key']],
    $origin,
    $config
);
