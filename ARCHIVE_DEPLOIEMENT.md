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

### 13. Blocage de fonctions reservees au Pro

Le backend bloque deja les actions de type `SCAN` si le compte n'est pas `PRO`.

Cela prepare la suite pour :

- scan de billet par camera
- automatisation avancee
- fonctions premium

## Etat actuel du projet

Le projet est aujourd'hui :

- deploye
- accessible publiquement
- capable de creer un compte
- capable de verifier un courriel
- capable de connecter un utilisateur
- capable d'ajouter, modifier et supprimer des tickets
- capable de gerer un debut de logique Free / Pro
- pret a finaliser Stripe

## Ce qui reste a faire

Pour terminer completement l'offre payante, il reste a finaliser :

- `STRIPE_SECRET_KEY` dans Render
- `STRIPE_PRICE_MONTHLY` dans Render
- `STRIPE_PRICE_YEARLY` dans Render
- `STRIPE_WEBHOOK_SECRET` dans Render
- webhook Stripe vers Render
- tests de paiement reels en mode test

## Emplacement des fichiers importants

- backend : [server.js](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/server.js)
- frontend : [index.html](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/public/index.html)
- variables exemple : [.env.example](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/.env.example)
- config Render : [render.yaml](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/render.yaml)
- package : [package.json](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/package.json)

## Resume court

Le projet LottoTracker a ete fusionne en une seule version stable basee sur `V4`, modernise avec verification email Resend, deploye sur Render, pousse sur GitHub, puis prepare pour un vrai modele SaaS Free / Pro avec Stripe.
