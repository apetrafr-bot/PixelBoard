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

L’intégration serveur cible un hébergement mutualisé PHP avec PHP 8.1 ou ultérieur, PDO MySQL et une base MySQL/MariaDB. Publier uniquement les fichiers statiques ne permet pas de créer des comptes. Le bouton **Connexion** reste visible même sans API : il explique alors ce qui manque. Les données locales ne sont ni effacées ni envoyées automatiquement.

1. Dans Hostinger, créez une base MySQL et un utilisateur avec accès à cette base; activez HTTPS pour le domaine avant d’utiliser l’API. L’API marque le cookie de session `Secure` lorsque PHP détecte HTTPS (`$_SERVER['HTTPS']`). Si un proxy ou une configuration particulière masque cette valeur, vérifiez-la ou corrigez la configuration avant d’ouvrir les comptes; ne transmettez jamais le secret d’installation en HTTP.
2. Importez `api/schema.sql` dans cette base via phpMyAdmin.
3. Dans le gestionnaire de fichiers Hostinger, créez **`public_html/api/config.php`** en copiant le contenu de **`api/config.example.php`** du dépôt. Remplacez les champs suivants avec les valeurs de votre base Hostinger (pas votre mot de passe de compte Hostinger) :

| Champ dans `config.php` | Valeur à saisir |
|---|---|
| `db.dsn` | `mysql:host=HOTE_MYSQL;dbname=NOM_COMPLET_BASE;charset=utf8mb4` : remplacer `HOTE_MYSQL` et `NOM_COMPLET_BASE` par les valeurs Hostinger, préfixes inclus |
| `db.username` | Nom complet de l’utilisateur MySQL autorisé sur cette base |
| `db.password` | Mot de passe de cet utilisateur MySQL |
| `setup_secret` | Votre secret aléatoire privé d’au moins 32 caractères, différent des mots de passe |

Ne commitez jamais ce fichier. `api/config.php` et `dist/api/config.php` sont ignorés par Git; `.htaccess` interdit la lecture HTTP directe de `config.php`. Ne mettez aucune de ces valeurs dans le JavaScript, GitHub ou le formulaire de connexion.

4. Construisez le site avec `npm ci` puis `npm run build`. Le build inclut automatiquement dans **`dist/api/` uniquement `index.php`, `lib.php` et `.htaccess`**. Publiez **tout le contenu** de `dist/` à la racine `public_html/`, dossier `api` et fichier caché `.htaccess` compris. SQL, tests et exemple de configuration ne sont pas copiés dans le build. Le build ne vide pas le dossier de sortie et ne copie jamais `config.php`; une configuration déjà présente est préservée. Au redéploiement, ne supprimez pas `public_html/api/config.php` : configurez votre outil de transfert pour préserver ce fichier (pas de suppression miroir de ce fichier). Le build peut laisser d’anciens assets hachés inutilisés; ne supprimez pas l’ensemble du répertoire serveur pour les nettoyer. L’API utilise `/api/index.php?action=...` sur la même origine.
5. Initialisez une seule fois le propriétaire depuis un terminal privé, jamais depuis le navigateur, en remplaçant les valeurs fictives :

```sh
curl -X POST "https://votre-domaine.example/api/index.php?action=setup" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: VOTRE_SECRET_D_INSTALLATION" \
  --data '{"workspace":"Mon équipe","name":"Votre nom","email":"vous@example.com","password":"REMPLACER_PAR_UN_MOT_DE_PASSE_LONG"}'
```

Cette opération est refusée dès qu’un espace existe. Connectez-vous ensuite dans PixelBoard et créez un code d’invitation à transmettre aux membres. Le code reste valable jusqu’à ce qu’un nouveau soit généré; générer un nouveau code invalide le précédent. Transmettez-le uniquement aux membres prévus; l’inscription exige toujours un code.
6. Après votre push, redéployez le contenu du build sur un hébergement exécutant PHP, pas seulement un hébergement statique Node/Vite. La configuration réelle se crée séparément sur Hostinger et reste hors Git. Ne mettez ni identifiants MySQL ni secret d’installation dans GitHub.

### Vérifier l’installation et se connecter comme propriétaire

Ouvrez `https://VOTRE-DOMAINE/api/index.php?action=auth`. Une 404 indique que le dossier API n’est pas publié au bon emplacement. Une réponse JSON 503 indique une configuration absente/incomplète ou MySQL indisponible : vérifiez `public_html/api/config.php`, PDO MySQL et le schéma importé. Une réponse JSON avec `user: null` et `csrf` signifie que l’API est joignable, pas qu’un compte existe.

Exécutez ensuite la requête `setup` de l’étape 5 sur votre domaine HTTPS avec votre secret privé, nom, adresse e-mail et nouveau mot de passe (12 caractères minimum). Elle crée le seul propriétaire initial (administrateur de l’équipe), puis le verrou SQL empêche une nouvelle initialisation. Cliquez sur **Connexion** et utilisez cette adresse e-mail et ce mot de passe. L’inscription publique sur invitation ne donne jamais le rôle propriétaire. Ne supprimez pas le secret de la configuration après installation : le serveur l’utilise aussi pour limiter les tentatives de connexion; c’est le verrou en base qui désactive le setup.

Les images de carte sont envoyées dans le JSON du tableau; le corps API est limité à 64 Mio. Configurez les limites PHP d’hébergement (`post_max_size` et `memory_limit`) en conséquence. La base et le compte Hostinger sont nécessaires avant que la création de compte, la connexion ou la synchronisation partagée puissent fonctionner. Aucun mot de passe réel ni identifiant d’hébergement n’est inclus dans le projet.

Le compte propriétaire est créé via l’étape d’installation; l’inscription ordinaire n’accorde jamais de privilège propriétaire. Les membres ne peuvent modifier que leur nom, tandis que le propriétaire peut modifier les noms, tags et couleurs de l’équipe. Les comptes ont besoin d’un code d’invitation. La vérification d’adresse e-mail et la récupération autonome de mot de passe ne sont pas incluses.

## Vérifications

```sh
npm run build
npm test
php -l api/index.php
php -l api/lib.php
php api/tests.php
```

Les commandes PHP nécessitent un interpréteur PHP en local. Les tests de `api/tests.php` couvrent les validations, la protection CSRF et les règles d’accès par espace/profil; un essai d’intégration réel nécessite également la base MySQL configurée sur l’hébergement.

## Import Milanote

Cette version ne propose pas d’import Milanote. Nous n’avons pas trouvé d’API ou d’intégration publique officiellement documentée et disponible pour importer des tableaux. L’interface l’indique clairement ; elle ne prétend pas effectuer un import et ne demande jamais de mot de passe Milanote. Ajoutez manuellement vos notes et images dans PixelBoard.
