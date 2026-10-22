# PAJ GPS

Suivez vos traceurs PAJ GPS (voiture, vélo, personnes, animaux, objets de
valeur) dans Gladys : position, vitesse, batterie, vu pour la dernière fois,
distance au domicile et « à la maison », et les alertes que PAJ lève (bouton
SOS, choc, batterie faible, zone…). Lecture seule, par le cloud de PAJ GPS
(connect.paj-gps.de), avec le compte de l'application PAJ.

> Cette intégration n'a jamais été testée avec un vrai traceur PAJ GPS ni un
> vrai compte : elle suit l'API documentée de PAJ et la bibliothèque
> pajgps-api. Signalez ce qui diffère. Intégration non officielle, sans lien
> avec PAJ.

## Mise en place

1. Saisissez l'**adresse e-mail** et le **mot de passe** de votre compte PAJ
   GPS (ceux de l'application PAJ ou de connect.paj-gps.de). Le mot de passe
   est gardé par Gladys dans sa base, jamais réaffiché, jamais journalisé,
   envoyé seulement à l'API PAJ GPS.
2. Choisissez le **rafraîchissement** (5 minutes par défaut, jamais moins) et
   le **rayon « à la maison »** (200 m par défaut).
3. Enregistrez. Gladys lit le compte, puis l'onglet **Découverte** liste un
   appareil par traceur (20 au plus) : ajoutez ceux que vous voulez.

Pour la distance au domicile, donnez une position à votre maison dans Gladys
(**Paramètres > Maisons**). À l'installation, Gladys vous demande de laisser
l'intégration lire la position de vos maisons : elle ne sert qu'ici, dans
votre Gladys, pour calculer les distances.

## Ce que donne chaque traceur

| Fonction                 | Ce que c'est                                                                    |
| ------------------------ | ------------------------------------------------------------------------------- |
| Latitude                 | Dernière position connue de PAJ (sans historique par défaut)                    |
| Longitude                | Dernière position connue de PAJ (sans historique par défaut)                    |
| Vitesse                  | km/h à la dernière position                                                     |
| Batterie                 | % (traceurs avec leur propre batterie seulement)                                |
| Vu pour la dernière fois | Date de la dernière position (UTC)                                              |
| Distance au domicile     | Mètres jusqu'à la maison de Gladys la plus proche qui a une position            |
| À la maison              | 1 dans le rayon ; 0 au-delà du rayon plus une marge (la moitié, 100 m au moins) |

Une position n'est publiée qu'une fois : un redémarrage de l'intégration ne
renvoie jamais une ancienne position comme une nouvelle. Tout est en lecture
seule : un traceur ne peut être ni allumé, ni réglé, ni localisé à la demande
depuis Gladys.

**Présence d'un utilisateur Gladys.** Gladys ne sait pas encore déplacer un
utilisateur sur sa carte depuis une intégration : utilisez la fonction « À la
maison » du traceur dans vos scènes (par exemple « quand À la maison de la
voiture passe à 1 »).

## Le déclencheur de scène « Alerte PAJ GPS »

Il se déclenche pour chaque alerte que PAJ enregistre pour un traceur **créé
dans Gladys** : choisissez un traceur (ou tous) et un type d'alerte (ou tous) :
SOS, choc (mouvement), batterie faible, rayon quitté, vitesse, alimentation
coupée, contact, chute, zone entrée, zone quittée, tension, éteint, autre. Les
alertes se règlent dans l'application PAJ (elles doivent y être activées).
Variables : le nom du traceur, le type d'alerte et son heure (UTC) ; jamais
la position.

- Lu au rythme du rafraîchissement : une alerte arrive avec au plus un
  intervalle de retard.
- Seules les alertes de la dernière heure déclenchent ; aucune pour ce qui
  s'est passé avant la création du traceur dans Gladys ou avant la première
  lecture.
- 30 événements au plus par lecture ; rien n'est marqué lu chez PAJ.

## Rythme, échecs et vie privée

- **Rythme.** Une lecture par intervalle : les traceurs et leurs dernières
  positions (deux requêtes), puis une requête par traceur créé dans Gladys
  pour ses alertes. Rien ne lit plus tôt : ni le bouton **Tester la
  connexion**, ni la Découverte, ni une reconnexion, ni l'enregistrement d'une
  configuration inchangée, ni un redémarrage (l'heure de la dernière tentative
  est gardée dans `/data`).
- **Identifiants refusés.** Quand PAJ refuse l'adresse e-mail ou le mot de
  passe, plus rien n'est envoyé avec eux (un mauvais mot de passe essayé
  encore et encore peut bloquer le compte). Corrigez-les et enregistrez, ou
  cliquez sur **Tester la connexion** : un essai de plus, jamais avant la fin
  de l'intervalle. Un nouveau jeton est demandé au plus une fois par lecture
  quand PAJ refuse l'actuel.
- **PAJ demande d'attendre** (HTTP 429, erreur serveur) : toutes les requêtes
  sont suspendues (Retry-After s'il est donné, 6 h au plus), même après un
  redémarrage. Une page 403 d'un pare-feu suspend 6 h (rien à voir avec les
  identifiants).
- **Vie privée.** L'intégration ne journalise jamais et n'écrit jamais sur
  disque les positions, les noms et numéros des traceurs, l'adresse e-mail,
  le mot de passe ni les jetons. `/data` ne garde que des empreintes salées,
  l'heure de la dernière tentative, une pause, et les dates de la dernière
  position et de la dernière alerte publiées. Les positions publiées sont
  gardées par Gladys comme toute autre valeur (sans historique sauf si vous
  l'activez). L'adresse e-mail et le mot de passe passent dans l'adresse de
  la requête de connexion, comme l'API PAJ le demande (en HTTPS, jamais
  journalisés).

## Limites

- 20 traceurs au plus par compte (ceux créés dans Gladys d'abord).
- Un traceur envoie sa position à son propre rythme (réglages PAJ), souvent
  moins souvent que le rafraîchissement.
- Jamais testée avec un vrai traceur (voir plus haut). La tension des
  traceurs de voiture, les zones et l'historique des trajets ne sont pas
  (encore) lus.

Référence : [pajgps-api](https://github.com/Skipperro/pajgps-api) (MIT),
portée en JavaScript.
