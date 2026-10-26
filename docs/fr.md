# Vanderbilt SPC

Votre centrale d'alarme **Vanderbilt SPC** (anciennement Siemens SPC) dans
Gladys, par la **SPC Web Gateway** de Lundix (un logiciel à part, installé sur
un ordinateur de votre réseau, qui dialogue avec la centrale), sans cloud :

- chaque **secteur** de la centrale devient un appareil Gladys : **mode**
  (hors service, partielle A, partielle B, totale, alarme), **armé**,
  **alarme**, et quatre **boutons** : mise en service totale, partielle A,
  partielle B, mise hors service ;
- chaque **zone** en devient un autre : son **état** (ouverture, mouvement,
  fumée, fuite d'eau ou simple entrée), **défaut** (autoprotection, défaut,
  court-circuit, coupure, masquage, hors ligne), **inhibée ou isolée**,
  **alarme** ;
- le **lien** avec la passerelle.

Les secteurs et les zones sont lus toutes les minutes, et les événements de
la centrale arrivent en direct par le websocket de la passerelle (une zone
qui s'ouvre s'affiche en moins d'une seconde).

> **Cette intégration n'a jamais été testée avec une vraie centrale.** Cette
> première version a été écrite à partir de la bibliothèque pyspcwebgw et de
> l'intégration `spc` de Home Assistant, et testée seulement contre une fausse
> passerelle. Dites sur le forum de Gladys ce qui marche et ce qui ne marche
> pas.

Intégration non officielle, sans lien avec Vanderbilt ni Lundix.

## Configuration

- **Adresse de la SPC Web Gateway** : l'adresse IP de l'ordinateur qui la
  fait tourner (`192.168.1.10`) ; un port peut suivre (`192.168.1.10:8088`,
  8088 par défaut). Préférez l'adresse IP (un nom `.local` ne se résout pas
  dans le conteneur de l'intégration) et donnez-lui une adresse fixe dans
  votre box. L'intégration parle en http simple à la passerelle sur votre
  réseau : gardez la passerelle sur votre réseau local. Le websocket est
  `ws://<adresse>/ws/spc`.
- **Identifiant / mot de passe de la passerelle** : seulement si votre
  passerelle en demande ; sinon laissez les deux vides. Ils ne sont envoyés
  qu'à la passerelle, et seulement quand elle les demande (elle répond 401
  avec un défi) : Digest si elle le propose (le mot de passe lui-même ne
  circule pas), sinon Basic. Le mot de passe est gardé par Gladys dans sa
  base, jamais réaffiché, jamais dans les journaux. Un mot de passe refusé par
  la passerelle arrête l'intégration (plus d'essai de lui-même, même après un
  redémarrage) jusqu'à ce que vous saisissiez d'autres identifiants ou
  appuyiez sur **Tester la connexion** (un essai). L'intégration ne retient de
  ce refus qu'un marqueur de 8 bits, d'où aucun mot de passe ne peut être
  retrouvé.
- **Autoriser la mise hors service (désarmement) depuis Gladys** : désactivé
  par défaut. Voir plus bas.
- **Types des zones** (facultatif) : comment certaines zones s'affichent, par
  leur numéro, par ex. `5:opening, 12:motion` (opening ouverture, motion
  mouvement, smoke fumée, leak fuite, input entrée). Par défaut le type de la
  zone sur la centrale décide : zone alarme : mouvement (comme Home
  Assistant), entrée/sortie : ouverture, feu : fumée, eau : fuite, les
  autres : entrée ; les zones inutilisées ne sont pas affichées. Un type changé
  pour une zone déjà créée apparaît après **Mettre à jour** dans l'onglet
  Découverte (d'ici là ses états vont à la fonctionnalité qu'elle a). Les
  entrées non comprises sont comptées dans le statut, jamais réaffichées.
- **Langue des appareils** : noms des fonctionnalités et des modes, et des
  secteurs et zones sans nom sur la centrale.

Les appareils apparaissent dans l'onglet **Découverte** une fois la passerelle
lue.

## Commandes

Chaque commande est un **bouton** (jamais un interrupteur) : « éteins tout »,
un assistant vocal ou une scène sur les interrupteurs ne peut pas désarmer
l'alarme.

### Mise en service (totale, partielle A, partielle B)

La mise en service est la commande protectrice. Elle ne demande aucune option
ni aucune lecture préalable : elle fonctionne dès le démarrage de
l'intégration, pendant que les lectures de la passerelle échouent et
attendent, et pendant qu'une lecture est en cours (elle a sa propre connexion ;
une lecture qui n'a rien reçu depuis 1 s est coupée). L'appui retire les mises
hors service du même secteur qui ne sont pas encore parties.

Sa requête est réessayée toutes les 250 ms jusqu'à 3,5 s après l'appui, puis
le secteur est relu jusqu'à 4,3 s :

- le secteur montre le mode : c'est fait ;
- la passerelle l'a acceptée mais le secteur ne la montre pas encore (la
  centrale peut être dans sa temporisation de sortie) : Gladys répond
  « envoyée et acceptée, pas encore visible », et le secteur est relu 5, 20 et
  60 s plus tard ;
- la requête n'a pas atteint la passerelle : Gladys le dit.

Une mise en service pas encore vue appliquée est **gardée** (y compris après
un redémarrage, 10 minutes au plus) et renvoyée, **3 fois au plus** : à la
lecture suivante quand elle n'a jamais atteint la passerelle, une fois qu'une
mise hors service de Gladys en vol au moment de l'appui a pu arriver après
elle, après un redémarrage, et à la relecture de 60 s si le secteur ne la
montre toujours pas. Elle n'est pas renvoyée quand le secteur la montre, quand
le secteur a été mis en service puis hors service par quelqu'un d'autre (son
heure de dernière mise en service a bougé ; la centrale ne donne pas cette
heure pour les partielles, si bien qu'une partielle remise hors service au
clavier dans cette minute peut être renvoyée une fois), ni quand une mise hors
service de Gladys demandée après elle est partie.

Une **partielle** n'abaisse jamais une mise en service totale (rien n'est
envoyé : le secteur reste en totale) et ne remplace jamais l'autre partielle
(refusée : totale, ou mise hors service d'abord). Pour le savoir, une
partielle lit d'abord le secteur (1,2 s au plus) ; si cette lecture échoue,
elle n'est envoyée que si le dernier état lu était « hors service ». Une
totale n'est pas retenue par cela.

La mise en service est **refusée** dans ces cas seulement :

- l'adresse manque ou n'est pas valide, ou la configuration a changé pendant
  la commande ;
- la passerelle a refusé les identifiants, en demande alors qu'aucun n'est
  donné, ou demande une authentification que l'intégration ne connaît pas ;
- une autre centrale répond à l'adresse (voir plus bas) ;
- une partielle alors que le secteur est dans l'autre partielle ;
- une partielle alors que l'état du secteur ne peut être lu ni maintenant ni
  depuis la dernière lecture (« hors service ») ;
- des mises en service précédentes du même secteur ont pris tout son temps
  (3,5 s).

La centrale peut aussi la refuser elle-même (zone ouverte ou en défaut, par
exemple) : Gladys dit alors « refusée par la centrale » et ne la renvoie pas.

### Mise hors service (désarmement)

Désactivée sauf si vous cochez **Autoriser la mise hors service
(désarmement) depuis Gladys**. Alors une mise hors service :

- est refusée tant que le numéro de série de la centrale n'a pas été lu
  depuis le démarrage de l'intégration (une lecture par minute) ;
- lit d'abord le secteur et le numéro de série de la centrale (en 2,5 s) et
  décide sur ce qu'elle lit : numéro illisible ou autre, rien n'est envoyé ;
  secteur illisible,
  rien n'est envoyé ; déjà hors service, rien n'est envoyé, sauf si une mise en
  service de Gladys peut encore s'appliquer ;
- revérifie l'option et les mises en service demandées entre-temps juste
  avant sa requête (une mise en service demandée après elle la retire) ;
- 6 au plus par secteur et par minute, une à la fois par secteur ;
- est confirmée par une lecture du secteur (en 4,3 s), sinon Gladys dit
  « envoyée, pas encore visible » ou « envoyée, sans réponse » et le secteur
  est relu 5 et 20 s plus tard.

## Identité de la centrale

Le numéro de série de la centrale est appris à la première lecture et
retenu. Si une autre centrale répond plus tard à la même adresse (changement
DHCP, autre passerelle), rien n'est publié ni envoyé, et le statut montre le
numéro de série rencontré. Si c'est la vôtre (centrale remplacée), appuyez sur
**Utiliser la centrale qui répond**.

## Statut et boutons

- Le statut de l'intégration dit si la passerelle répond, le nombre de
  secteurs et de zones, si les événements arrivent en direct, et sinon
  pourquoi.
- **Tester la connexion** : relit la configuration, fait un essai malgré des
  identifiants refusés (au plus toutes les 10 s), lit la passerelle quand le
  rythme le permet (jamais plus d'une fois par minute), puis rend compte.
- Les lectures en échec sont réessayées toutes les minutes au début, puis
  à 2, 4 et 5 minutes d’écart ; le
  websocket 15 s à 5 min plus tard. Un websocket refusé par la passerelle (401)
  n'est pas réessayé avant un changement de configuration : les lectures
  toutes les minutes continuent.

## Limites

- Jamais testée avec une vraie centrale ni une vraie passerelle (voir plus
  haut).
- Le chemin du websocket (`/ws/spc`) et l'authentification de la passerelle
  (Digest ou Basic, seulement sur demande) sont ceux documentés autour de Home
  Assistant et de pyspcwebgw, pas vérifiés sur une vraie passerelle.
- Pas de sorties, ni d'inhibition ou d'isolement de zone, ni de journal
  d'événements dans cette version.
- Les valeurs de plus de 2,5 minutes ne sont pas publiées (le lien s'affiche
  coupé).
