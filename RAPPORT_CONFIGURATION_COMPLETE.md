# Rapport complet de configuration LottoTracker

## But du rapport

Ce document sert d'archive technique pour retrouver :

- les services utilises
- les fichiers modifies
- les variables configurees
- les etapes de deploiement
- les prochaines actions necessaires

## 1. Code source local

Dossier principal :

`d:\LottoTracker\LottoTrackerV4\LottoTracker-SaaS`

Fichiers principaux :

- [server.js](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/server.js)
- [index.html](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/public/index.html)
- [.env.example](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/.env.example)
- [render.yaml](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/render.yaml)
- [package.json](/d:/LottoTracker/LottoTrackerV4/LottoTracker-SaaS/package.json)

## 2. GitHub

Depot GitHub :

`https://github.com/vinvin76/lotto-tracker`

Usage :

- stockage du code source
- liaison avec Render
- versionnement du projet

## 3. Render

Service utilise :

- Render Web Service

URL actuelle :

`https://lotto-tracker-75xe.onrender.com`

Role :

- heberger le backend Node/Express
- servir le frontend
- redemarrer automatiquement apres changement ou redeploiement

### Variables Render deja prevues

- `APP_BASE_URL`
- `JWT_SECRET`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `EMAIL_VERIFICATION_HOURS`
- `NODE_VERSION`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`
- `STRIPE_CUSTOMER_PORTAL_RETURN_URL`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`

## 4. Resend

Service utilise :

`https://resend.com`

Role :

- envoyer les courriels de confirmation d'inscription

Configuration necessaire :

- une cle API Resend
- un expediteur valide

Variables correspondantes :

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`

## 5. Stripe

Service utilise :

`https://dashboard.stripe.com`

Mode utilise actuellement :

- bac a sable / test

Role :

- abonnement payant
- plan mensuel
- plan annuel
- portail client
- webhooks de paiement

### Produit cree

Produit :

`Lotto Tracker Pro`

### Prix crees

- `2.00 $ / mois`
- `20.00 $ / an`

Les identifiants des prix commencent par :

- `price_...`

Ils doivent etre mis dans Render :

- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`

## 6. Configuration complete des variables

### Variables application

```env
APP_BASE_URL=https://lotto-tracker-75xe.onrender.com
JWT_SECRET=cle-secrete-longue-et-unique
EMAIL_VERIFICATION_HOURS=24
NODE_VERSION=22.18.0
```

### Variables Resend

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=LottoTracker <adresse-valide>
```

### Variables Stripe

```env
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_MONTHLY=price_...
STRIPE_PRICE_YEARLY=price_...
STRIPE_CUSTOMER_PORTAL_RETURN_URL=https://lotto-tracker-75xe.onrender.com/?view=billing
STRIPE_CHECKOUT_SUCCESS_URL=https://lotto-tracker-75xe.onrender.com/?billing=success
STRIPE_CHECKOUT_CANCEL_URL=https://lotto-tracker-75xe.onrender.com/?billing=cancel
```

## 7. Configuration technique du backend

Le backend gere :

- auth utilisateur
- hash du mot de passe
- JWT
- verification email
- inscription en attente avant activation du vrai compte
- tickets
- dashboard
- plan Free / Pro
- creation session Stripe Checkout
- creation session Stripe Customer Portal
- reception des webhooks Stripe

### Tables SQLite importantes

- `users`
- `tickets`
- `email_verification_tokens`
- `pending_registrations`
- `subscriptions`
- `payment_events`

## 7b. Admin

URL admin :

`https://lotto-tracker-75xe.onrender.com/admin.html`

Variables Render necessaires :

```env
ADMIN_PASSWORD=ton-mot-de-passe-admin
ADMIN_MFA_SECRET=cle-base32-optionnelle
```

Fonctions disponibles :

- liste des utilisateurs avec statut Free / Pro
- donner ou retirer le plan Pro sans Stripe (plan cadeau)
- creer des codes promo Stripe
- envoyer des courriels promotionnels aux utilisateurs selectionnes

## 8. Configuration technique du frontend

Le frontend gere :

- choix public `Gratuit` ou `Pro`
- choix public `Mensuel` ou `Annuel` pour `Pro`
- panneau slide-up au clic sur un prix Pro (formulaire integre)
- inscription Free et Pro depuis le panneau
- redirection automatique vers Stripe apres inscription Pro
- connexion
- verification email via lien
- affichage dashboard
- liste des tickets
- export JSON
- panneau abonnement
- boutons Pro mensuel / Pro annuel
- bouton de gestion d'abonnement
- avertissement legal visible
- mention de droits reserves dans le footer

## 9. Tunnel public retenu

Le tunnel souhaite pour la partie publique est :

1. choisir l'offre
2. choisir mensuel ou annuel
3. entrer ses infos
4. payer
5. activer le compte
6. acceder a l'application

Implementation en cours dans le code :

- si l'utilisateur choisit `Gratuit`
  - creation d'une inscription en attente
  - confirmation courriel
  - creation du vrai compte apres validation
  - connexion
- si l'utilisateur choisit `Pro`
  - choix `Mensuel 2,00 $` ou `Annuel 20,00 $`
  - creation d'une inscription en attente
  - creation d'une session Stripe Checkout
  - redirection vers Stripe
  - retour au site
  - confirmation courriel
  - creation du vrai compte apres validation
  - connexion

## 10. Logique d'activation du compte

Le systeme a ete ajuste pour que l'adresse courriel ne soit pas ajoutee trop tot dans `users`.

Logique retenue :

1. l'utilisateur remplit le formulaire
2. le serveur stocke l'inscription dans `pending_registrations`
3. un token de confirmation est associe a cette inscription
4. apres clic sur le lien, le serveur cree l'utilisateur dans `users`
5. l'inscription temporaire est ensuite supprimee

Ce choix evite :

- les comptes incomplets
- les faux doublons
- le message "courriel deja utilise" alors qu'aucun compte actif n'existe encore

## 11. Configuration Stripe a terminer

### Etape 1

Creer ou recuperer :

- `STRIPE_SECRET_KEY`

Dans Stripe :

- `Developers`
- `API keys`
- copier la cle secrete test `sk_...`

### Etape 2

Mettre dans Render :

- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_YEARLY`
- `STRIPE_SECRET_KEY`

### Etape 3

Creer le webhook Stripe.

URL du webhook :

`https://lotto-tracker-75xe.onrender.com/api/stripe/webhook`

Evenements a selectionner :

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

### Etape 4

Recuperer le secret du webhook :

- `whsec_...`

Puis le coller dans Render :

- `STRIPE_WEBHOOK_SECRET`

### Etape 5

Sauvegarder Render et laisser redeployer.

### Etape 6

Tester :

- connexion au site
- clic sur Pro mensuel
- ouverture Stripe Checkout
- paiement test
- retour sur le site
- verification du plan dans l'interface

## 12. Configuration des tests Stripe

Pour tester en mode sandbox Stripe :

- utiliser une carte de test Stripe
- verifier que le webhook remonte
- verifier que l'utilisateur passe en `PRO`

## 13. Services utilises dans le projet

### Local

- Node.js
- Express
- SQLite
- bcryptjs
- jsonwebtoken

### Cloud / SaaS

- GitHub
- Render
- Resend
- Stripe

## 14. Etat d'avancement

### Fait

- fusion des versions
- creation de la version unique
- deploiement sur Render
- verification email via Resend
- GitHub
- debut complet Free / Pro
- integration code Stripe
- choix public Gratuit / Pro
- choix public Mensuel / Annuel
- debut du tunnel Pro avant connexion
- inscription en attente avant creation du vrai compte

### En cours de finalisation

- configuration finale Stripe dans Render
- webhook Stripe
- test de paiement complet

## 15. Recommandations pour archive

Conserver ces informations :

- URL Render
- URL GitHub
- copie des variables non secretes
- emplacement des fichiers locaux
- prix mensuel et annuel
- URL webhook Stripe
- liste des evenements Stripe

Ne jamais archiver en clair :

- `JWT_SECRET`
- `RESEND_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

## 16. Resume final

LottoTracker est maintenant une application publique deployee, avec compte utilisateur, verification email, gestion de tickets et base de logique SaaS Free / Pro. Le code Stripe est en place. La derniere phase consiste a finir la configuration Stripe cote dashboard et variables Render pour activer les paiements de test et ensuite la mise en production.
