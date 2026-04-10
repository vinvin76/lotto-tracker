# Archive de travail LottoTracker

## Objectif du projet

Fusionner les 5 versions de LottoTracker en une seule application publique, fonctionnelle et deployable.

## Base retenue

La base principale retenue est `LottoTrackerV4/LottoTracker-SaaS` parce que :

- elle contenait deja un vrai backend Express
- elle utilisait SQLite
- elle avait une base de structure SaaS plus solide que les autres versions

## Travail realise

### 1. Analyse des 5 versions

Les 5 versions ont ete comparees pour identifier :

- la version la plus stable pour le backend
- la meilleure base de front
- les fonctions reelles et les fonctions seulement simulees
- les problemes d'encodage, de structure et de deploiement

Conclusion :

- `V1`, `V2`, `V3` etaient surtout des prototypes frontend/PWA
- `V4` etait la meilleure base technique
- `V5` avait surtout des idees d'interface mais pas un backend totalement coherent

### 2. Fusion en une seule version

Le projet final a ete concentre dans :

`d:\LottoTracker\LottoTrackerV4\LottoTracker-SaaS`

La version fusionnee comprend :

- un frontend unique
- un backend Express unique
- une base SQLite locale
- un dashboard utilisateur
- la gestion des tickets
- l'export JSON
- une interface responsive
- une PWA installable

### 3. Correction du mode de lancement

Le projet ne devait plus etre ouvert avec `file:///...`.

Le bon mode d'utilisation a ete fixe :

- lancement avec `node server.js`
- ouverture par navigateur sur `http://localhost:3000`

### 4. Mise en place de l'authentification

Fonctions ajoutees ou stabilisees :

- creation de compte
- connexion
- session JWT
- lecture du profil courant

### 5. Confirmation du courriel

Le systeme de verification email a ete ajoute avec :

- table `email_verification_tokens`
- generation de token
- lien de validation
- blocage de connexion tant que l'email n'est pas confirme
- renvoi du courriel de verification
- inscription stockee en attente avant creation definitive du compte

Integration mail :

- Resend

Variables ajoutees :

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `EMAIL_VERIFICATION_HOURS`

### 6. Preparation au deploiement

Fichiers ajoutes :

- `.env.example`
- `render.yaml`
- `.gitignore`

Le projet a ete prepare pour un deploiement sur Render.

### 7. Git et GitHub

Le depot Git a ete initialise et nettoye.

Travail effectue :

- suppression de `node_modules` du suivi Git
- retrait de la base SQLite du suivi Git
- ajout d'un `.gitignore`
- creation du premier commit propre
- configuration du remote GitHub
- push sur le depot :

`https://github.com/vinvin76/lotto-tracker`

### 8. Deploiement Render

Le site a ete deploye sur Render.

URL publique actuelle :

`https://lotto-tracker-75xe.onrender.com`

Variables Render configurees au cours du travail :

- `APP_BASE_URL`
- `JWT_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `EMAIL_VERIFICATION_HOURS`
- `NODE_VERSION`

### 9. Configuration Resend

Resend a ete utilise pour permettre l'envoi du courriel de confirmation.

Travail fait :

- creation d'une cle API
- configuration de l'expediteur
- remplacement de la cle quand elle a ete exposee dans une capture

### 10. Architecture Free / Pro

Une logique SaaS a ensuite ete preparee avec :

- plan `FREE`
- plan `PRO`
- prix :
  - `2.00 $ / mois`
  - `20.00 $ / an`

### 11. Ajout de Stripe dans le projet

Le projet a ete modifie pour supporter Stripe directement.

Travail code :

- ajout de la dependance Stripe dans `package.json`
- ajout des variables Stripe dans `.env.example`
- ajout des variables Stripe dans `render.yaml`
- reconstruction de `server.js` avec logique billing
- ajout des tables :
  - `subscriptions`
  - `payment_events`
- ajout des routes :
  - `GET /api/billing/status`
  - `POST /api/billing/create-checkout-session`
  - `POST /api/billing/create-customer-portal`
  - `POST /api/stripe/webhook`

### 12. Mise a jour du frontend pour Free / Pro

Le frontend `public/index.html` a ete modifie pour afficher :

- le plan actuel
- l'etat de l'abonnement
- le bouton Pro mensuel
- le bouton Pro annuel
- le bouton de gestion d'abonnement
- le retour apres paiement ou annulation
- un choix `Gratuit` ou `Pro` avant la creation du compte
- un choix `Mensuel 2,00 $` ou `Annuel 20,00 $` avant la creation du compte Pro
- un avertissement legal visible sur la page publique
- la mention des droits reserves en bas de page

### 13. Refonte du tunnel public Pro

Le parcours public a ensuite ete realigne sur une logique commerciale plus claire.

Ordre retenu :

1. choisir l'offre
2. choisir mensuel ou annuel
3. entrer ses informations
4. payer
5. activer le compte
6. acceder a l'application

Implementation actuelle :

- `Gratuit` : inscription en attente avant activation
- `Pro` : choix du cycle de facturation avant inscription
- le backend cree d'abord une inscription en attente
- si Stripe est configure, le backend genere une session Checkout Stripe
- le frontend redirige ensuite directement vers Stripe

### 14. Nouvelle logique d'inscription en attente

Le parcours d'inscription a ete corrige pour eviter qu'un courriel soit considere "deja utilise" alors que le compte n'a jamais ete active.

Nouvelle logique :

1. l'utilisateur remplit le formulaire
2. le serveur enregistre une ligne dans `pending_registrations`
3. le courriel de confirmation est envoye
4. le vrai compte n'entre dans `users` qu'apres clic sur le lien de confirmation
5. une inscription non confirmee ne cree donc pas encore un compte actif

Avantages :

- plus de confusion sur les doublons
- plus de faux "courriel deja utilise"
- la base `users` contient uniquement les comptes actives
### 15. Blocage de fonctions reservees au Pro

Le backend bloque deja les actions de type `SCAN` si le compte n'est pas `PRO`.

Cela prepare la suite pour :

- scan de billet par camera
- automatisation avancee
- fonctions premium

### 16. Panneau Pro glissant

Un panneau slide-up a ete ajoute dans le frontend. Quand l'utilisateur clique sur "Mensuel 2,00 $" ou "Annuel 20,00 $", un panneau s'ouvre depuis le bas avec le formulaire d'inscription complet (nom, courriel, mot de passe). Apres soumission, redirection automatique vers Stripe Checkout.

### 17. Correction email non-bloquant

Le serveur ne retourne plus d'erreur 500 si l'envoi du courriel Resend echoue. L'echec est logge mais l'inscription continue.

### 18. Page admin

Une page admin complete a ete ajoutee a `/admin.html` :

- protegee par mot de passe (`ADMIN_PASSWORD` dans Render)
- MFA optionnel (`ADMIN_MFA_SECRET` dans Render)
- liste tous les utilisateurs (gratuit + Pro)
- donner / retirer le plan Pro sans Stripe (colonne `plan_gifted`)
- creation de codes promo Stripe
- envoi de courriels promotionnels aux utilisateurs selectionnes

### 19. Corrections de bugs critiques

- le plan Pro est maintenant correctement conserve lors de la verification du courriel (correction du hardcode `FREE`)
- les codes promo Stripe sont actives au checkout (`allow_promotion_codes: true`)
- un message d'erreur clair s'affiche si Stripe n'est pas configure au moment de l'inscription Pro

### 20. Resend — probleme expediteur

`RESEND_FROM_EMAIL` doit utiliser un domaine verifie dans Resend. L'adresse `onboarding@resend.dev` est utilisee en attendant la verification du domaine `vsstudiocreations.ca`. La verification DNS du domaine reste a faire via Planet Hoster (panneau N0C / mg.n0c.com).

## Etat actuel du projet

Le projet est aujourd'hui :

- deploye sur Render
- accessible publiquement
- inscription Free et Pro fonctionnelle
- panneau Pro glissant avec formulaire integre
- redirection vers Stripe Checkout au moment de l'inscription Pro
- activation du compte Pro via webhook Stripe
- page admin protegee par mot de passe
- gestion des plans depuis l'admin (cadeau Pro sans Stripe)
- codes promo Stripe creables depuis l'admin
- envoi de courriels depuis l'admin

## Ce qui reste a faire

- verifier le domaine `vsstudiocreations.ca` dans Resend via Planet Hoster (mg.n0c.com) pour que les courriels partent depuis `boutique@vsstudiocreations.ca`
- tester le flux complet de paiement Pro en mode test Stripe
- confirmer que `STRIPE_PRICE_MONTHLY` et `STRIPE_PRICE_YEARLY` sont bien configures dans Render

## Emplacement des fichiers importants

- backend : [server.js](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/server.js)
- frontend : [index.html](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/public/index.html)
- variables exemple : [.env.example](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/.env.example)
- config Render : [render.yaml](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/render.yaml)
- package : [package.json](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/package.json)

## Resume court

Le projet LottoTracker a ete fusionne en une seule version stable basee sur `V4`, modernise avec verification email Resend, deploye sur Render, pousse sur GitHub, puis prepare pour un vrai modele SaaS Free / Pro avec Stripe.
