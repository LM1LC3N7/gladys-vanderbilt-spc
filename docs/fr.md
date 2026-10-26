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
la centrale arrivent par le websocket de la passerelle (quand il est ouvert,
une zone qui s'ouvre s'affiche en général en moins d'une seconde).

> **Cette intégration n'a jamais été testée avec une vraie centrale.** Cette
> première version a été écrite à partir de la bibliothèque pyspcwebgw et de
> l'intégration `spc` de Home Assistant, et testée seulement contre une fausse
> passerelle. Plusieurs points sont des hypothèses, listées dans « Limites ».
> Dites sur le forum de Gladys ce qui marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec Vanderbilt ni Lundix.

> **Fausse alarme.** Mettre un secteur en service alors que quelqu'un est à
> l'intérieur (scène mal réglée, appui par erreur) peut déclencher une fausse
> alarme : sirènes, et appel de votre télésurveillance si vous en avez une.

## Configuration

- **Adresse de la SPC Web Gateway** : l'adresse IP de l'ordinateur qui la
  fait tourner (`192.168.1.10`) ; un port peut suivre (`192.168.1.10:8088`,
  8088 par défaut). Préférez l'adresse IP (un nom `.local` ne se résout pas
  dans le conteneur de l'intégration) et donnez-lui une adresse fixe dans
  votre box. L'intégration parle en http simple à la passerelle sur votre
  réseau : gardez la passerelle sur votre réseau local. Le websocket est
  supposé à `ws://<adresse>/ws/spc` (non vérifié sur une vraie passerelle).
- **Identifiant / mot de passe de la passerelle** : seulement si votre
  passerelle en demande ; sinon laissez les deux vides. Ils ne sont envoyés
  qu'à la passerelle, et seulement quand elle les demande (elle répond 401
  avec un défi) : Digest si elle le propose (le mot de passe lui-même ne
  circule pas). Le mot de passe est gardé par Gladys dans sa base, jamais
  réaffiché, jamais dans les journaux. Un mot de passe refusé par la
  passerelle arrête les lectures (plus de lecture d'elle-même, même après un
  redémarrage) jusqu'à ce que vous saisissiez d'autres identifiants ou
  appuyiez sur **Tester la connexion** (un essai) ; une mise en service fait
  quand même un essai par appui, et une réussite lève l'arrêt. L'intégration
  ne retient de ce refus qu'un marqueur de 8 bits, d'où aucun mot de passe ne
  peut être retrouvé.
- **Autoriser l'authentification Basic** : désactivé par défaut. En Basic,
  l'identifiant et le mot de passe sont **lisibles par quiconque écoute votre
  réseau local, à chaque lecture** (toutes les minutes), et ils permettent de
  désarmer l'alarme. Sans cette option, une passerelle qui demande Basic ne
  reçoit rien et le statut le dit. Une fois Digest réussi avec la passerelle,
  une demande de Basic plus tard n'est pas répondue (un autre appareil à
  l'adresse pourrait lire le mot de passe) : les lectures s'arrêtent et le
  statut le dit, jusqu'à ce que vous vérifiiez la passerelle et appuyiez sur
  **Tester la connexion**.
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
  entrées non comprises sont comptées dans le statut, pas réaffichées.
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
attendent, pendant qu'une lecture est en cours (elle a sa propre connexion ;
une lecture qui n'a rien reçu depuis 1 s est coupée) et pendant qu'un refus
des identifiants est retenu (un essai par appui). L'appui retire les mises
hors service du même secteur qui ne sont pas encore parties, y compris celle
dont la connexion n'est pas encore établie.

Sa requête est réessayée toutes les 250 ms jusqu'à 3,5 s après l'appui tant
qu'elle n'atteint pas la passerelle (sur une réponse HTTP 5xx, un seul
nouvel essai), puis le secteur est relu jusqu'à 4,3 s :

- le secteur montre le mode : c'est fait ;
- la passerelle l'a acceptée mais le secteur ne la montre pas encore :
  Gladys répond « envoyée et acceptée, pas encore visible », et le secteur est
  relu 5, 20 et 60 s plus tard. **Elle n'est pas envoyée une deuxième fois** :
  la centrale peut être dans sa temporisation de sortie, une zone peut être
  ouverte, ou quelqu'un à l'intérieur peut l'avoir annulée au clavier. Si le
  secteur ne la montre toujours pas après 60 s, le statut de l'intégration le
  dit ;
- la passerelle a répondu une erreur HTTP 4xx : « refusée par la
  passerelle », pas renvoyée ; elle signale un échec (`status` autre que
  succès) et le secteur ne montre pas le mode : « refusée par la centrale » ;
- la requête n'a pas atteint la passerelle (ou n'a pas eu de réponse
  valable) : Gladys le dit. Elle est renvoyée (3 fois au plus, dans les
  **2 minutes** qui suivent l'appui, y compris après un redémarrage)
  seulement sur une lecture fraîche du secteur qui le montre exactement tel
  qu'il était lu avant l'appui (mode, heure de dernière mise en service,
  heure de dernière mise hors service ; cette lecture datant de moins de
  150 s avant l'appui) et sans événement de mise en ou hors service de la
  centrale depuis l'appui. Sinon elle est abandonnée et le statut dit de la
  refaire.

Une mise en service appuyée alors qu'une mise hors service de Gladys du même
secteur est déjà sur le réseau peut être dépassée par elle : une fois cette
mise hors service répondue, le secteur est relu et la mise en service est
renvoyée une fois si le secteur ne la montre pas.

Une **partielle** n'est pas envoyée sur une totale lue à cet instant (rien
n'est envoyé : le secteur reste en totale) ni sur l'autre partielle
(refusée : totale, ou mise hors service d'abord). Pour le savoir, une
partielle lit d'abord le secteur (1,2 s au plus) ; si cette lecture échoue,
elle n'est envoyée que si le dernier état lu était « hors service » (lecture
qui peut dater d'une minute), et tant qu'une mise hors service de Gladys du
secteur est incertaine elle est envoyée sans ce contrôle. Une totale n'est
pas retenue par cela.

La mise en service est **refusée** dans ces cas seulement :

- la configuration de Gladys n'est pas encore lue (redemandée), l'adresse
  manque ou n'est pas valide, ou la configuration a changé pendant la
  commande ;
- la passerelle demande des identifiants alors qu'aucun n'est donné, demande
  Basic sans autorisation (ou après un Digest réussi), ou une
  authentification que l'intégration ne connaît pas ;
- une autre centrale répond à l'adresse (voir plus bas) ;
- une partielle alors que le secteur est dans l'autre partielle ;
- une partielle alors que l'état du secteur ne peut être lu ni maintenant ni
  depuis la dernière lecture (« hors service ») ;
- des mises en service précédentes du même secteur ont pris tout son temps
  (3,5 s) ;
- une mise hors service de Gladys demandée après elle est partie avant.

La passerelle ou la centrale peuvent aussi la refuser (erreur HTTP, échec
signalé, zone ouverte) : Gladys le dit alors.

### Mise hors service (désarmement)

Désactivée sauf si vous cochez **Autoriser la mise hors service
(désarmement) depuis Gladys**.

> **Aucun code n'est demandé.** Une fois l'option cochée, tout utilisateur de
> Gladys, toute scène, l'application mobile et un tableau de bord sur une
> tablette d'entrée peuvent mettre un secteur hors service. Ne placez pas le
> bouton de mise hors service sur un tableau de bord accessible depuis
> l'entrée.

Alors une mise hors service :

- est refusée tant que le numéro de série de la centrale n'a pas été lu
  depuis le démarrage de l'intégration (une lecture par minute) ;
- lit d'abord le secteur et le numéro de série de la centrale (en 2,5 s) et
  décide sur ce qu'elle lit : numéro illisible ou autre, rien n'est envoyé ;
  secteur illisible, rien n'est envoyé ; déjà hors service, rien n'est
  envoyé, sauf si une mise en service de Gladys peut encore s'appliquer ;
- revérifie l'option et les mises en service demandées entre-temps juste
  avant sa requête (une mise en service demandée après elle la retire, y
  compris quand sa connexion n'est pas encore établie) ;
- 6 au plus par secteur et par minute, une à la fois par secteur ;
- est confirmée par une lecture du secteur (en 4,3 s), sinon Gladys dit
  « envoyée, pas encore visible » ou « envoyée, sans réponse » et le secteur
  est relu 5 et 20 s plus tard. Elle n'est pas renvoyée d'elle-même.

## Identité de la centrale

Le numéro de série de la centrale est appris à la première lecture, retenu,
et relu à chaque lecture. Si une autre centrale répond plus tard à la même
adresse (changement DHCP, autre passerelle), rien n'est publié ni envoyé, et
le statut montre le numéro de série rencontré. Si c'est la vôtre (centrale
remplacée), appuyez sur **Utiliser la centrale qui répond**.

## Statut et boutons

- Le statut de l'intégration dit si la passerelle répond, le nombre de
  secteurs et de zones, si les événements arrivent en direct (et le statut
  HTTP du websocket quand il est refusé), l'usage de Basic, et ce qu'est
  devenue une mise en service non visible.
- **Tester la connexion** : relit la configuration, fait un essai malgré des
  identifiants refusés (au plus toutes les 10 s), oublie que Digest a réussi
  (Basic demande toujours son option), lit la passerelle quand le rythme le
  permet (pas plus d'une fois par minute), puis rend compte.
- Les lectures en échec sont réessayées toutes les minutes au début, puis
  à 2, 4 et 5 minutes d’écart ; le websocket 15 s à 5 min plus tard. Un
  websocket refusé par l'authentification de la passerelle (401) n'est pas
  réessayé avant un changement de configuration : les lectures toutes les
  minutes continuent.

## Limites

- Pas testée avec une vraie centrale ni une vraie passerelle (voir plus
  haut). Ces points sont des hypothèses tirées de Home Assistant et de
  pyspcwebgw, à vérifier :
  - le chemin du websocket (`/ws/spc`) et l'authentification de la
    passerelle (Digest ou Basic, seulement sur demande) ;
  - ce que lit un secteur pendant la temporisation de sortie ;
  - la réponse de la passerelle à une mise en service refusée par la
    centrale (zone ouverte) : `{ "status": "failed" }`, une erreur HTTP, ou
    un succès sans effet ;
  - si l'heure de dernière mise en service d'un secteur bouge pour une
    partielle ;
  - la réponse à une mise en service d'un secteur déjà en totale ;
  - le numéro de série (`sn`) de la centrale sur tous les firmwares ;
  - la taille de la liste des zones avec 512 zones (1 Mo lu au plus).
- Pas de sorties, ni d'inhibition ou d'isolement de zone, ni de journal
  d'événements dans cette version.
- Les valeurs de plus de 2,5 minutes ne sont pas publiées (le lien s'affiche
  coupé).
