<?php
declare(strict_types=1);

// Copier dans pixelboard-config.php, a cote de public_html (pas dedans).
// Remplacer les valeurs ci-dessous uniquement dans cette copie privee.
return [
    'db' => [
        // Hote MySQL et nom COMPLET de la base indiques dans Hostinger.
        'dsn' => 'mysql:host=HOTE_MYSQL;dbname=NOM_COMPLET_BASE;charset=utf8mb4',
        // Utilisateur MySQL associe a cette base, pas le compte Hostinger.
        'username' => 'UTILISATEUR_MYSQL_COMPLET',
        'password' => 'MOT_DE_PASSE_MYSQL',
    ],
    // Secret prive aleatoire de 32 caracteres minimum. Remplacer tout le texte.
    'setup_secret' => 'replace-with-a-random-secret-of-at-least-32-characters',
];
