# UPS Expéditions

Petite application locale : elle récupère les commandes à expédier sur eBay, Etsy et Shopify, vous saisissez les colis, elle compare les tarifs UPS, vous validez, elle génère les bordereaux.

## Déroulé

1. **Actualiser les commandes** : commandes payées et non expédiées des trois plateformes.
2. Pour chaque colis : format (ou L × l × H), poids, contenu, valeur déclarée, code SH facultatif si hors UE. La saisie est enregistrée automatiquement.
3. **Obtenir les tarifs** : l'outil interroge UPS en mode « Shop » (tous les services) puis présélectionne :
   - France / Europe : le service le moins cher ;
   - reste du monde : Express Saver, ou le moins cher (avec alerte) si Express Saver n'est pas proposé.
   Vous pouvez changer le service dans la liste déroulante.
4. **Valider et générer** : récapitulatif avec le total, puis création des expéditions. Les étiquettes (et la facture commerciale hors UE) sont enregistrées dans `data/labels/AAAA-MM-JJ/`.
5. **Imprimer** : page d'impression au format 10 × 15 (thermique) ou A4 (2 par page).

Une commande déjà étiquetée ne peut pas être étiquetée une seconde fois par erreur. Le bouton « Annuler l'étiquette » annule l'envoi chez UPS.

## Installation (Windows)

1. Installer Node.js (version LTS) : https://nodejs.org
2. Dézipper le dossier où vous voulez.
3. **Essai sans rien configurer** : double-cliquer sur `UPS Expeditions - DEMO.vbs` (fausses commandes, faux tarifs, http://localhost:3001).
4. **Utilisation réelle** : double-cliquer sur `UPS Expeditions.vbs`. Au premier lancement le fichier `.env` s'ouvre dans le Bloc-notes : remplissez-le, enregistrez, relancez. Un raccourci « UPS Expéditions » est créé sur le Bureau.

Aucune fenêtre noire : l'application tourne en arrière-plan et l'interface s'ouvre dans le navigateur (http://localhost:3000). Relancer le raccourci rouvre simplement l'interface. Pour l'arrêter : bouton **Quitter**. En cas de problème au démarrage, le détail est dans `data/server.log`.

## Version en ligne (Render)

L'application peut tourner sur Render : adresse https fixe, connexions eBay / Etsy / Shopify automatiques, accessible depuis n'importe quel appareil.

1. Sur https://dashboard.render.com : **New → Blueprint**, choisir le dépôt `ups-expeditions`. Render lit `render.yaml` (instance 0.5c-512mb à 7 $/mois + disque 1 Go à 0,25 $/mois, région Frankfurt).
2. Renseigner les valeurs demandées (`sync: false`) : mot de passe `APP_PASSWORD`, identifiants UPS, eBay, Etsy, Shopify, téléphone expéditeur.
3. Une fois l'adresse connue (ex. `https://ups-expeditions.onrender.com`), la déclarer :
   - **Etsy** (etsy.com/developers/your-apps → l'app → Callback URLs) : `https://…/auth/etsy/callback`
   - **eBay** (developer.ebay.com → User Tokens → le RuName → *Your auth accepted URL*) : `https://…/auth/ebay/callback`
   - **Shopify** (app → URLs de redirection autorisées) : `https://…/auth/shopify/callback`, avec le droit `read_orders` et l'accès aux données client protégées.
4. Ouvrir l'adresse, se connecter avec le mot de passe, cliquer « Connecter » pour chaque plateforme.

Les données (connexions, historique, étiquettes) sont sur le disque persistant `/var/data`. Sans `APP_PASSWORD`, l'application en ligne reste verrouillée.

## Identifiants à renseigner dans `.env`

### UPS
Sur https://developer.ups.com → *Apps* → créer une app liée à votre numéro de compte, avec les produits **Rating**, **Shipping** et **Authorization (OAuth)**. Copier le *Client ID* et le *Client Secret*.

Commencez avec `UPS_ENV=test` (étiquettes factices), puis passez à `UPS_ENV=production`.

Tarifs négociés : `UPS_NEGOTIATED_RATES=true` n'affiche vos tarifs contractuels que si le compte y est autorisé. Sinon ce sont les tarifs publics.

### eBay
Sur https://developer.ebay.com → *Application Keys* (Production) : *App ID* = `EBAY_CLIENT_ID`, *Cert ID* = `EBAY_CLIENT_SECRET`. Dans *User Tokens* → *Get a Token from eBay via Your Application*, créez un **RuName** et mettez-le dans `EBAY_RUNAME`.

Connexion : cliquer sur « Connecter » à côté d'eBay, accepter, puis coller dans l'application l'adresse de la page sur laquelle eBay vous renvoie. La connexion dure environ 18 mois.

Erreur `invalid_request / Input request parameters are invalid` : l'App ID et le RuName ne correspondent pas (App ID de Sandbox, RuName d'une autre app ou adresse http au lieu du RuName). L'application signale ces cas dans l'encadré « Configuration ».

### Etsy
Sur https://www.etsy.com/developers/your-apps : *Keystring* et *Shared secret*. Etsy n'accepte que des adresses de rappel en `https://` : mettez dans `ETSY_REDIRECT_URI` une des *Callback URLs* déjà déclarées dans cette même app (par ex. celle de l'outil SEO), copiée à l'identique. Cliquez sur « Connecter » à côté d'Etsy, autorisez, puis collez dans l'application l'adresse de la page d'arrivée.

Etsy ne transmet pas le téléphone de l'acheteur : l'outil met alors celui de l'expéditeur. Vous pouvez le modifier via « modifier l'adresse ».

### Shopify
Depuis le 1er janvier 2026, les nouvelles apps se créent dans le **Dev Dashboard**. Créez-en une, installez-la sur votre boutique avec le droit `read_orders`, et demandez l'accès aux **données client protégées** (nom, adresse, e-mail), sans quoi l'adresse de livraison ne remonte pas. Renseignez `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID` et `SHOPIFY_CLIENT_SECRET`.

Si vous avez une ancienne app personnalisée avec un jeton `shpat_…`, mettez-le dans `SHOPIFY_ADMIN_TOKEN` à la place.

## Points à vérifier au premier envoi réel

- L'adresse et le **téléphone** expéditeur dans `.env` (le téléphone est obligatoire pour l'international).
- L'impression de la première étiquette : l'orientation se fait automatiquement, mais testez sur votre imprimante.
- Droits et taxes : par défaut ils sont payés par le destinataire. Mettez `UPS_DDP=true` pour les prendre à votre charge.
- Le contenu déclaré doit être rédigé en anglais pour la douane. Le code SH est facultatif (6 à 15 chiffres, ex. 970690) : sans code, l'envoi part quand même mais peut être plus long à dédouaner.

## Fichiers

- `data/labels/` : étiquettes et factures commerciales.
- `data/shipments.json` : historique des bordereaux.
- `data/tokens.json` : connexions eBay et Etsy. **Ne pas partager.**
- `data/presets.json` : formats de colis (Petit, Moyen, Grand), à modifier au Bloc-notes selon vos cartons.
