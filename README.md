# PixelBoard

Un atelier visuel en français pour disposer librement notes, images, liens, tableaux imbriqués et tâches. Le canvas se déplace dans toutes les directions et les images agrandies conservent leurs pixels nets.ssssssssssss

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
3. Dans le gestionnaire de fichiers Hostinger, créez **`pixelboard-config.php` à côté du dossier `public_html`**, et non dedans, en copiant le contenu de **`api/config.example.php`** du dépôt. Ce fichier reste hors du dossier remplacé lors des déploiements. Remplacez les champs suivants avec les valeurs de votre base Hostinger (pas votre mot de passe de compte Hostinger) :

| Champ dans `config.php` | Valeur à saisir |
|---|---|
| `db.dsn` | `mysql:host=HOTE_MYSQL;dbname=NOM_COMPLET_BASE;charset=utf8mb4` : remplacer `HOTE_MYSQL` et `NOM_COMPLET_BASE` par les valeurs Hostinger, préfixes inclus |
| `db.username` | Nom complet de l’utilisateur MySQL autorisé sur cette base |
| `db.password` | Mot de passe de cet utilisateur MySQL |
| `setup_secret` | Votre secret aléatoire privé d’au moins 32 caractères, différent des mots de passe |

Ne commitez jamais ce fichier. Ne mettez aucune de ces valeurs dans le JavaScript, GitHub ou le formulaire de connexion. PHP doit pouvoir lire ce fichier hors de `public_html`; si une restriction `open_basedir` l'interdit, faites ajuster le chemin autorisé par l'hébergeur.

**Migration d'une installation existante :** déplacez `public_html/api/config.php` vers `pixelboard-config.php` dans le dossier parent de `public_html`, sans changer son contenu. L'API lit ce nouvel emplacement en priorité et conserve l'ancien emplacement en secours pour les installations non migrées. Si le fichier a déjà été supprimé, recréez-le à ce nouvel emplacement avec les mêmes identifiants MySQL et le même secret si vous en avez une sauvegarde. Sans sauvegarde du secret, choisissez-en un nouveau. Ne réimportez pas le schéma et ne relancez pas le setup si votre base et votre propriétaire existent déjà.

4. Construisez le site avec `npm ci` puis `npm run build`. Le build inclut automatiquement dans **`dist/api/` uniquement `index.php`, `lib.php` et `.htaccess`**. Publiez **tout le contenu** de `dist/` à la racine `public_html/`, dossier `api` et fichier caché `.htaccess` compris. SQL, tests et exemple de configuration ne sont pas copiés dans le build. Le build ne vide pas le dossier de sortie et ne copie jamais `config.php`; une configuration déjà présente est préservée par le build, mais pas nécessairement par Hostinger. Limitez le déploiement à `public_html` pour préserver `pixelboard-config.php` placé dans son dossier parent. Si vous gardez l'ancien emplacement `public_html/api/config.php`, votre outil de transfert doit explicitement préserver ce fichier (pas de suppression miroir). Le build peut laisser d'anciens assets hachés inutilisés. L'API utilise `/api/index.php?action=...` sur la même origine.
5. Ouvrez le site en **HTTPS**, puis **Connexion**. Si la base n'a jamais été initialisée, la section **Créer mon compte administrateur** apparaît. Saisissez votre équipe, nom, e-mail, nouveau mot de passe et le `setup_secret` du fichier privé Hostinger. Aucun code d'invitation n'est nécessaire. Le secret est transmis uniquement dans l'en-tête HTTPS, jamais dans l'URL ou le stockage local; les champs secrets sont vidés après la tentative. Après succès, connectez-vous : la section disparaît. Le verrou transactionnel en base interdit toute seconde création, même depuis une autre fenêtre ou par appel direct. Aucun visiteur ne peut devenir propriétaire sans le secret.

Pour une installation automatisée, l'appel terminal reste possible en remplaçant les valeurs fictives :

```sh
curl -X POST "https://votre-domaine.example/api/index.php?action=setup" \
  -H "Content-Type: application/json" \
  -H "X-Setup-Secret: VOTRE_SECRET_D_INSTALLATION" \
  --data '{"workspace":"Mon équipe","name":"Votre nom","email":"vous@example.com","password":"REMPLACER_PAR_UN_MOT_DE_PASSE_LONG"}'
```

Cette opération est refusée dès qu’un espace existe. Connectez-vous ensuite dans PixelBoard et créez un code d’invitation à transmettre aux membres. Le code reste valable jusqu’à ce qu’un nouveau soit généré; générer un nouveau code invalide le précédent. Transmettez-le uniquement aux membres prévus; l’inscription exige toujours un code.
6. Après votre push, redéployez le contenu du build sur un hébergement exécutant PHP, pas seulement un hébergement statique Node/Vite. La configuration réelle se crée séparément sur Hostinger et reste hors Git. Ne mettez ni identifiants MySQL ni secret d’installation dans GitHub.

### Vérifier l’installation et se connecter comme propriétaire

Ouvrez `https://VOTRE-DOMAINE/api/index.php?action=auth`. Une 404 indique que le dossier API n'est pas publié au bon emplacement. Une réponse JSON 503 indique une configuration absente/incomplète ou MySQL indisponible : vérifiez `pixelboard-config.php` dans le dossier parent de `public_html` (ou l'ancien `public_html/api/config.php`), PDO MySQL et le schéma importé. Une réponse JSON avec `user: null` et `csrf` signifie que l'API est joignable, pas qu'un compte existe.

Utilisez ensuite le formulaire de première installation de l'étape 5 (ou l'appel `setup` automatisé) avec votre secret privé, nom, adresse e-mail et nouveau mot de passe (12 caractères minimum). Il crée le seul propriétaire initial (administrateur de l’équipe), puis le verrou SQL empêche une nouvelle initialisation. Cliquez sur **Connexion** et utilisez cette adresse e-mail et ce mot de passe. L’inscription publique sur invitation ne donne jamais le rôle propriétaire. Ne supprimez pas le secret de la configuration après installation : le serveur l’utilise aussi pour limiter les tentatives de connexion; c’est le verrou en base qui désactive le setup.

Les images de carte sont envoyées dans le JSON du tableau; le corps API est limité à 64 Mio. Configurez les limites PHP d’hébergement (`post_max_size` et `memory_limit`) en conséquence. La base et le compte Hostinger sont nécessaires avant que la création de compte, la connexion ou la synchronisation partagée puissent fonctionner. Aucun mot de passe réel ni identifiant d’hébergement n’est inclus dans le projet.

Le compte propriétaire est créé via l’étape d’installation; l’inscription ordinaire n’accorde jamais de privilège propriétaire. Les membres ne peuvent modifier que leur nom, tandis que le propriétaire peut modifier les noms, tags et couleurs de l’équipe. Les comptes ont besoin d’un code d’invitation. La vérification d’adresse e-mail et la récupération autonome de mot de passe ne sont pas incluses.

Dans l'interface, **Membres** est réservé au propriétaire connecté (administrateur). Les tâches restent accessibles aux membres. Les profils locaux existants sont conservés mais ne donnent aucun droit administrateur. Pour créer un compte membre, le propriétaire utilise **Mon compte → Créer un code d'invitation**; le membre choisit **Connexion → Créer un compte avec une invitation** et saisit ce code. Le formulaire local « Ajouter un membre » n'est plus proposé : il ne créait pas de compte.

## Vérifications

### Accès au site

Le site affiche d'abord une page de connexion, sans canvas ni outils accessibles hors session. Après authentification, l'espace partagé s'ouvre; une déconnexion ou une réponse API 401 réaffiche la connexion. Si l'API est absente ou indisponible, le diagnostic et un bouton de nouvelle tentative restent affichés, sans bascule vers un éditeur local. Les anciennes données IndexedDB sont conservées et leur import reste explicite après connexion. L'inscription membre exige toujours une invitation; le formulaire propriétaire reste limité au setup initial protégé. Le masquage de l'éditeur ne remplace pas les autorisations de l'API.

### Mise à jour photos et édition des cartes

Pour une base existante, importez **une seule fois `api/migration-avatar.sql`** via phpMyAdmin avant de publier cette version (ajout de la colonne `users.avatar_data`, sans suppression de données). Une nouvelle base utilise directement `api/schema.sql`. Chaque utilisateur connecté peut modifier ou retirer sa propre photo dans **Mon compte**; une miniature PNG 128 × 128 est conservée sur le serveur et affichée à côté du bouton. Ne réimportez pas le schéma complet sur une base existante.

Les quatre coins des cartes permettent de modifier largeur et hauteur au pointeur/toucher ou aux flèches. Les connecteurs neufs sont noirs; sélectionnez-en un pour régler sa couleur et sa courbure. Les couleurs explicites des connecteurs existants sont conservées. En cas de conflit, exportez votre copie avant **Mon compte → Recharger la copie serveur** si vous souhaitez conserver les changements locaux.

Les poignées de carte sont discrètes (sans carrés verts) et restent accessibles au clavier. La barre du haut tient sur une seule ligne; sur écran étroit, elle défile horizontalement pour conserver toutes les actions. Dans Mon compte, l'aperçu affiche la photo actuelle; « Retirer » apparaît seulement lorsqu'une photo existe.

Les connecteurs attachés se terminent aux bordures des cartes plutôt que dans leur contenu. Les points d'ancrage enregistrés sont conservés; le rendu se recalcule lorsque les cartes bougent ou changent de taille. Le trait et les pointes sont affinés.

Le bouton « Liste » crée une carte compacte avec un titre facultatif et plusieurs tâches à cocher, modifiables et supprimables individuellement. Chaque tâche possède deux tags modifiables : son responsable et son état (À faire, En cours, Terminée). « Ajouter une tâche » ajoute une ligne sans responsable. Chaque ligne apparaît aussi dans le panneau Tâches et dans le profil du membre assigné; changer son état ne modifie pas les autres lignes. Les anciennes listes conservent leurs cases et leur attribution initiale, désormais modifiable par ligne. Les listes sont conservées dans les mêmes sauvegardes locales, exports et tableaux partagés que les autres cartes; aucune migration SQL n'est nécessaire.

Les cartes tâches utilisent le même affichage léger que les listes : une case et deux tags modifiables (responsable et état), sans badge redondant. La touche Entrée insère un retour à la ligne dans les tâches, les lignes de liste et leur titre facultatif; ces retours sont conservés dans les sauvegardes. Une icône PixelBoard SVG est incluse pour les onglets du navigateur.

### Version de travail et copie protégée administrateur

Pour une base existante, importez **une seule fois `api/migration-backups.sql` dans phpMyAdmin**, puis publiez le nouveau `dist` (interface et API). Ne réimportez pas `schema.sql` sur une base existante. Sans cette migration, le site et les comptes restent utilisables; les boutons de protection affichent une erreur explicite. Pour une base neuve, la table est incluse dans `schema.sql`.

Dans **Mon compte → Copie protégée administrateur**, le propriétaire dispose de :

- **Valider cette version** : enregistre le travail puis copie tous les tableaux de l’espace, y compris leurs images et listes, dans un emplacement serveur protégé. Une nouvelle validation remplace la précédente. Il faut effectuer cette première validation pour activer la protection; aucune copie administrateur n’est inventée automatiquement.
- **Restaurer la version validée** : remet les tableaux validés dans l’espace de travail. Les tableaux créés après la validation restent conservés. Une carte/tableau supprimé par un membre peut ainsi être retrouvé avec son contenu et ses liens validés.
- **Récupérer le travail avant restauration** : restaure la copie de travail prise juste avant la dernière restauration. Chaque restauration remplace cet emplacement de secours; ce n’est pas un historique illimité.

La version courante reste dans `boards`; la référence validée et le travail avant restauration sont dans `workspace_backups`. Les écritures ordinaires des membres ne touchent jamais ces copies. Les opérations de protection sont réservées au propriétaire côté API, avec session et CSRF. Les écritures et les copies verrouillent le même espace dans une transaction; un changement concurrent non encore chargé provoque un refus plutôt qu’un écrasement silencieux. Les versions des tableaux restaurés augmentent pour que les anciennes copies des autres navigateurs provoquent un conflit au prochain enregistrement au lieu d’écraser la restauration.

La protection concerne les tableaux de l’espace, pas les comptes, profils ou codes d’invitation. Elle ne remplace pas une sauvegarde externe Hostinger/MySQL : une suppression de la base ou de l’espace par un accès administrateur à l’hébergement supprimerait aussi ces copies.

### Accéder aux tableaux de l’équipe

Les comptes doivent appartenir au même espace (inscription via l'invitation du propriétaire). Les tableaux créés hors connexion restent locaux : utilisez **Mon compte → Importer les tableaux de cet appareil** pour en ajouter des copies au serveur. La liste de tableaux dans la barre verte permet d'ouvrir directement tout tableau chargé de l'espace. **Actualiser** récupère les changements partagés; la synchronisation automatique intervient toutes les 15 secondes hors saisie/interaction en cours. **Recentrer** ramène la vue sur les cartes sans les déplacer.

### Diagnostic PHP sans SSH

Les connexions MySQL distinguent aussi `DATABASE_DRIVER_MISSING` (extension PDO MySQL absente), `DATABASE_AUTH_REJECTED` (authentification refusée), `DATABASE_ACCESS_DENIED` (droits sur la base), `DATABASE_UNKNOWN` (base inconnue), `DATABASE_UNREACHABLE` (serveur inaccessible) et `DATABASE_LIMIT` (limite de connexions/ressources). La classification utilise uniquement les codes numériques MySQL, jamais le message brut contenant potentiellement des identifiants. Un code ne prouve pas à lui seul quelle valeur doit être changée : par exemple, une authentification refusée peut aussi dépendre de l'hôte autorisé pour l'utilisateur.

Après redéploiement, une erreur API renvoie un `diagnostic` et une `reference`, sans secret ni chemin privé. Codes : `CONFIG_SYNTAX` (syntaxe du fichier privé), `CONFIG_LOAD` (chargement/configuration), `SESSION_START` (session PHP), `DATABASE_CONNECT` (connexion MySQL), `DATABASE_INIT` ou `REQUEST_FAILED` (traitement API).

Dans le gestionnaire de fichiers Hostinger, ouvrez **`pixelboard-private-logs/errors.log` dans le dossier parent de `public_html`**. Ce journal contient uniquement date, référence, étape et classe d'exception : aucun message brut, identifiant MySQL ou contenu utilisateur. Faites correspondre la référence à celle de la réponse API. Le dossier est créé avec des permissions privées; il ne doit jamais être publié ni déplacé dans `public_html`. Si PHP ne peut pas écrire ici, un message `PixelBoard private log unavailable` avec la même référence est envoyé au journal PHP de l'hébergeur.

Une erreur de syntaxe du fichier de configuration chargé est interceptée. Une erreur de syntaxe dans le code de l'API lui-même ou un arrêt du moteur PHP avant le gestionnaire exige toujours le journal PHP Hostinger. Ces codes localisent la panne mais ne remplacent pas systématiquement ce journal. Aucun endpoint public de consultation des logs n'est fourni.

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
