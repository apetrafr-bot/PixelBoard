<?php
declare(strict_types=1);

// On Hostinger, save as pixelboard-config.php beside public_html, not inside it.
return [
    'db' => [
        'dsn' => 'mysql:host=localhost;dbname=pixelboard;charset=utf8mb4',
        'username' => 'replace-with-database-user',
        'password' => 'replace-with-database-password',
    ],
    'setup_secret' => 'replace-with-a-random-secret-of-at-least-32-characters',
];
