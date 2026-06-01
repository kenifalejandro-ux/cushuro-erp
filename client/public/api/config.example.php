/**client/public/api/config.example.php */


<?php

declare(strict_types=1);

return [
    // Correo de destino que recibira los formularios.
    'contact_destination' => 'contacto@empresa.com',

    // Remitente usado por la funcion mail() del hosting.
    'email_from' => 'no-reply@tu-dominio.com',
    'email_from_name' => 'Formulario Web',

    // Claves de Google reCAPTCHA v3.
    'recaptcha_site_key' => 'replace-with-recaptcha-site-key',
    'recaptcha_secret_key' => 'replace-with-recaptcha-secret-key',
    'recaptcha_expected_action' => 'submit',
    'recaptcha_min_score' => 0.5,

    // Opcional: si lo dejas vacio, la API permite el mismo host actual y localhost.
    'allowed_origins' => [
        'https://https://kenifa2.sg-host.com/',
        'https://https://kenifa2.sg-host.com/',
    ],

    'rate_limit_window_ms' => 60000,
    'rate_limit_max_requests' => 5,

    // Mantiene la confirmacion actual del frontend.
    'redirect_to' => '/formulario',

    // Opcional: ruta absoluta para un log simple si quieres auditar errores.
    // 'log_file' => '/home/usuario/logs/formulario.log',
];
