# Modern Forms

Intègre à Gladys les ventilateurs de plafond connectés **Modern Forms** et
**WAC** (générations 1, 2 et 3) par leur API HTTP locale : sans compte, sans
cloud.

> Jamais testé avec un vrai appareil : construit d’après la référence WAC de
> l’API et la bibliothèque aiomodernforms (utilisée par Home Assistant).
> Dites-nous sur le forum comment ça se passe avec votre ventilateur. Sans lien
> avec WAC Lighting ni Modern Forms.

## Ce que vous obtenez

Un appareil par ventilateur, nommé comme dans l’application Modern Forms,
avec :

- **Vitesse du ventilateur (0 = arrêt)** : 0 arrête le ventilateur, 1 à 6 le
  met en marche à cette vitesse ;
- **Sens de rotation** : avant (été) ou inverse (hiver) ;
- **Mode brise** (ventilateurs de 3e génération) : arrêt ou brise ;
- **Lumière** et **Intensité** (ventilateurs avec kit d’éclairage) : l’intensité
  0 éteint la lumière, 1 à 100 % l’allume à cette intensité.

Aucune n’est un interrupteur : « allumer tous les interrupteurs » ne démarre
jamais un ventilateur. La lumière est une lumière : elle suit « éteindre les
lumières » comme les autres.

Non gérés : les minuteries, le programme, le mode absence, l’apprentissage,
l’appairage, le redémarrage et la remise à zéro (passez par l’application), et
les ventilateurs de **4e génération** (une autre API ; l’état dit « pas d’API
/mf (HTTP 404) »).

## Configuration

1. Installez le ventilateur avec l’application Modern Forms ou WAC, puis
   donnez-lui une adresse fixe dans votre box (il y apparaît comme
   `MF_Fan_XXXXXX` ou `WAC_Fan_XXXXXX`).
2. Dans **Adresses des ventilateurs**, saisissez l’adresse de chaque
   ventilateur, séparées par des virgules (8 au plus), avec `:port` seulement
   si ce n’est pas le 80.
3. Enregistrez, puis ajoutez les ventilateurs depuis l’onglet **Découverte**.

L’état dit quels ventilateurs ont été lus, quelle adresse ne répond pas (et
quand elle est réessayée), une adresse où le même ventilateur a été saisi deux
fois, un appareil qui répond sans dire quel ventilateur il est, et les arrêts
pas encore vus appliqués.

**Tester la connexion** lit chaque ventilateur, ou montre sa dernière lecture
s’il a été lu il y a moins d’un intervalle (jamais plus vite que l’intervalle).

## Quel ventilateur un appareil pilote

Un appareil est lié à son ventilateur par le `clientId` que le ventilateur
donne dans chaque réponse (son adresse MAC), pas par son adresse. Si le
ventilateur change d’adresse, saisissez la nouvelle : l’appareil le suit.

- Une mise en marche, une vitesse, un sens, la brise, la lumière allumée ou une
  intensité : le ventilateur est d’abord lu, et la commande n’est écrite que si
  cette lecture montre le ventilateur de l’appareil, à une adresse de la
  configuration.
- Un arrêt part vers l’adresse où le ventilateur a été lu en dernier (ou
  gardée dans /data, ou enregistrée avec l’appareil, ou la seule adresse
  saisie), même si rien n’a encore été lu. Il est **refusé** seulement quand :
  - l’adresse du ventilateur n’est pas connue : jamais lu, rien de gardé,
    aucune adresse sur l’appareil et plusieurs adresses saisies ;
  - un autre ventilateur a répondu en dernier à cette adresse. Tant qu’aucune
    lecture ne l’a montré, un ventilateur échangé avec un autre à la même
    adresse n’est pas vu : un arrêt envoyé alors peut arrêter l’autre
    ventilateur (sa réponse le dit, et rien n’est gardé) ;
  - une commande plus récente sur la même partie (un autre arrêt) a pris sa
    place avant son départ.

## Les arrêts (vitesse 0, lumière éteinte, intensité 0)

Un arrêt ne demande aucune option et passe en premier : il n’attend ni une
lecture, ni une commande en cours, ni une pause après des lectures en échec,
ni la configuration de Gladys (quand l’adresse est connue), ni la première
lecture après un redémarrage. Il annule les commandes de la même partie encore
en attente et coupe la requête en cours vers ce ventilateur.

S’il ne peut pas partir tout de suite (le ventilateur ne répond pas), il est
réessayé pendant 250 ms, puis **gardé** (dans /data, et en mémoire si /data ne
peut pas être écrit) et réessayé toutes les 10 s, quelle que soit la pause des
lectures : il part dans les 10 s environ après le retour du ventilateur, et de
nouveau après une réponse 429 ou 503, une coupure ou un envoi resté sans
réponse, sans fin : rien de cela n’est un essai. Une fois que le ventilateur
l’a accepté, une lecture qui montre encore la partie en marche le renvoie, et
ce même tour de 10 s aussi quand aucune lecture ne l’a fait (des lectures en
pause après une panne ne le retiennent jamais) : une fois par intervalle de
lecture au plus (10 s au plus) et 3 fois au plus ; un essai ne compte que si le
ventilateur a accepté l’arrêt et que sa réponse montre encore la partie en
marche. Seules les lectures jugent un arrêt, chacun sur sa partie (la réponse
de l’arrêt de la lumière ne renvoie jamais celui du ventilateur). L’état dit
où en est chaque arrêt.

Un arrêt gardé prend fin quand une commande plus récente qui remet la même
partie en marche est partie (une que le ventilateur a refusée ne compte pas),
quand l’appareil est supprimé, ou, après qu’une lecture l’a montré appliqué,
quand la partie est lue en marche deux fois de suite (remise en marche par la
télécommande ou l’application : l’intégration ne l’arrête plus). Jamais par le
temps.

## Lectures et pauses

Chaque ventilateur est lu à chaque intervalle (10 s par défaut, 5 s au moins),
jamais plus tôt, même après un redémarrage ou une reconnexion (une commande
ajoute ses propres lectures : celle d’avant, puis celles de 5 s et 20 s après). Un ventilateur
qui ne répond pas est réessayé après 10 s, 30 s, 1, 2 puis 5 minutes (une
minute au moins s’il demande d’attendre) ; ses commandes sont refusées entre
temps, mais pas ses arrêts. Une commande est confirmée par l’état que répond le
ventilateur (les commandes d’une scène sur un même ventilateur partent ensemble :
une lecture, une écriture) : « envoyée, sans confirmation » sans réponse, « ne l’affiche pas
encore » quand la réponse montre l’ancienne valeur ; le ventilateur est alors
relu 5 s et 20 s plus tard.

## Vie privée

Les informations du ventilateur contiennent aussi l’e-mail du compte de
l’application : il n’est jamais utilisé, journalisé ni gardé. /data ne garde
que les adresses, les identifiants des ventilateurs, les heures des lectures,
les pauses et les arrêts à envoyer.
