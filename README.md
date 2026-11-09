# PixelBoard

Un atelier visuel en français pour disposer librement notes, images, liens, tableaux imbriqués et tâches. Le canvas se déplace dans toutes les directions et les images agrandies conservent leurs pixels nets.

## Lancer en local

Prérequis : Node.js 18 ou une version ultérieure compatible avec Vite 6.

```sh
npm install
npm run dev
```

Ouvrez l’adresse locale affichée par Vite. Pour vérifier une compilation de production :

```sh
npm run build
npm run preview
```

## Fonctionnalités

- Canvas spatial déplaçable avec souris, pavé tactile ou toucher ; zoom du tableau et recentrage.
- Ajouter et déplacer des notes, liens, tâches, connecteurs, dessins et tableaux imbriqués depuis la barre d’outils.
- Renommer les titres des tableaux, cartes et profils, puis modifier le rôle et la couleur de chaque membre. Le nom d’un tableau imbriqué reste synchronisé avec son tableau et son fil d’Ariane.
- Relier deux cartes avec l’outil Connecteur : faites glisser d’une carte à l’autre pour créer une flèche attachée, qui suit leurs déplacements et changements de taille. Les traits statiques créés dans une version antérieure restent conservés comme tracés libres.
- Sélectionner un connecteur pour déplacer ses deux points d’ancrage sur les cartes liées, à la souris, au toucher ou avec les flèches du clavier. Les connecteurs suivent toujours les déplacements et changements de taille des cartes. Les traits statiques créés dans une version antérieure restent conservés comme tracés libres.
- Sélectionner un connecteur ou un dessin en cliquant sur son trait, puis le supprimer avec le bouton affiché dans la barre du canvas ou la touche Suppr.
- Choisir une image de couverture pour chaque tableau imbriqué depuis l’action ▧ de sa carte. Les couvertures sont enregistrées dans IndexedDB et incluses dans l’export JSON.
- Changer la couleur du cadre et du fond de chaque carte image sans recolorer ses pixels d’origine.
- Déposer plusieurs images directement sur le canvas, ou les choisir avec le bouton d’ajout. Les fichiers d’origine sont conservés dans IndexedDB et l’affichage agrandi utilise un rendu pixelisé. Formats acceptés : PNG, JPG, WEBP et GIF, jusqu’à 15 Mo par fichier.
- Déplacer une image agrandie dans son cadre sans déplacer la carte. Le cadrage est sauvegardé avec le zoom et se règle aussi avec les flèches quand l’image a le focus.
- Mode Équipe local avec profils, couleurs, tags, tâches assignables, filtres d’état et tâches par profil. Ce mode reste stocké uniquement dans IndexedDB sur l’appareil.
- Mode Équipe partagé optionnel via l’API PHP/MySQL : comptes membre créés avec invitation, connexion par session, tableaux/tâches conservés sur le serveur et profils modifiables par le propriétaire. Les tableaux se synchronisent par interrogation périodique; une version concurrente déclenche un conflit explicite plutôt qu’un écrasement silencieux. La copie locale peut être exportée, puis publiée à la place du serveur ou remplacée par la version serveur après confirmation. Importer les tableaux locaux ajoute des copies séparées dans l’espace partagé, sans écraser les tableaux du serveur ni supprimer les originaux locaux. Sans API configurée, PixelBoard reste en mode local.
- Annuler/rétablir, supprimer le contenu du tableau courant et exporter l’espace entier au format JSON.
- En mode local, les données restent dans IndexedDB sur cet appareil. En mode partagé, les tableaux sont stockés sur le serveur MySQL; les images sont incluses dans les données JSON. L’import vers l’espace partagé est une action explicite et ne supprime pas la copie locale.

## Préparer l’hébergement Hostinger

L’intégration serveur cible un hébergement mutualisé PHP avec PHP 8.1 ou ultérieur, PDO MySQL et une base MySQL/MariaDB. Elle n’est pas encore configurée pour un VPS Node. Aucun dépôt GitHub n’est créé ou publié depuis ce dossier.

1. Dans Hostinger, créez une base MySQL et un utilisateur avec accès à cette base; activez HTTPS pour le domaine avant d’utiliser l’API. L’API marque le cookie de session `Secure` lorsque PHP détecte HTTPS (`$_SERVER['HTTPS']`). Si un proxy ou une configuration particulière masque cette valeur, vérifiez-la ou corrigez la configuration avant d’ouvrir les comptes; ne transmettez jamais le secret d’installation en HTTP.
2. Importez `api/schema.sql` dans cette base via phpMyAdmin.
3. Créez `api/config.php` à partir de `api/config.example.php` avec le DSN, l’utilisateur et le mot de passe MySQL. Remplacez `setup_secret` par un secret aléatoire d’au moins 32 caractères. Ne commitez jamais `api/config.php`; `.gitignore` l’exclut et `api/.htaccess` interdit sa lecture HTTP directe.
4. Construisez le site avec `npm ci` puis `npm run build`. Publiez le contenu de `dist/` à la racine `public_html/`, et publiez dans `public_html/api/` uniquement `index.php`, `lib.php` et `.htaccess`. Gardez les fichiers SQL, tests et configuration d’exemple dans le dépôt, pas dans le répertoire public. L’API utilise `/api/index.php?action=...` sur la même origine.
5. Initialisez une seule fois le propriétaire depuis un terminal privé, jamais depuis le navigateur, en remplaçant les valeurs fictives :

```sh
curl -X POST "https://votre-domaine.example/api/index.php?action=setup" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: VOTRE_SECRET_D_INSTALLATION" \
  --data '{"workspace":"Mon équipe","name":"Votre nom","email":"vous@example.com","password":"REMPLACER_PAR_UN_MOT_DE_PASSE_LONG"}'
```

Cette opération est refusée dès qu’un espace existe. Connectez-vous ensuite dans PixelBoard et créez un code d’invitation à transmettre aux membres. Le code reste valable jusqu’à ce qu’un nouveau soit généré; générer un nouveau code invalide le précédent. Transmettez-le uniquement aux membres prévus; l’inscription exige toujours un code.
6. Pour lier Hostinger à GitHub, poussez vous-même le dépôt vers le dépôt privé souhaité et configurez le déploiement Git dans Hostinger ou une action de déploiement avec ses propres secrets. Le build Vite doit être exécuté avant publication; les fichiers PHP et la configuration serveur doivent être publiés séparément. Ne mettez ni identifiants MySQL ni secret d’installation dans GitHub.

Les images de carte sont envoyées dans le JSON du tableau; le corps API est limité à 64 Mio. Configurez les limites PHP d’hébergement (`post_max_size` et `memory_limit`) en conséquence. La base et le compte Hostinger sont nécessaires avant que la création de compte, la connexion ou la synchronisation partagée puissent fonctionner. Aucun mot de passe réel ni identifiant d’hébergement n’est inclus dans le projet.

Le compte propriétaire est créé via l’étape d’installation; l’inscription ordinaire n’accorde jamais de privilège propriétaire. Les membres ne peuvent modifier que leur nom, tandis que le propriétaire peut modifier les noms, tags et couleurs de l’équipe. Les comptes ont besoin d’un code d’invitation. La vérification d’adresse e-mail et la récupération autonome de mot de passe ne sont pas incluses.

## Vérifications

```sh
npm run build
php -l api/index.php
php -l api/lib.php
php api/tests.php
```

Les commandes PHP nécessitent un interpréteur PHP en local. Les tests de `api/tests.php` couvrent les validations, la protection CSRF et les règles d’accès par espace/profil; un essai d’intégration réel nécessite également la base MySQL configurée sur l’hébergement.

## Import Milanote

Cette version ne propose pas d’import Milanote. Nous n’avons pas trouvé d’API ou d’intégration publique officiellement documentée et disponible pour importer des tableaux. L’interface l’indique clairement ; elle ne prétend pas effectuer un import et ne demande jamais de mot de passe Milanote. Ajoutez manuellement vos notes et images dans PixelBoard.
