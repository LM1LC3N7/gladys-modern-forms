// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French.
// -----------------------------------------------------------------------------

import { FEATURES as F, PARTS } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Several messages one after the other, in each language. */
export const join = (...messages) => {
  const parts = messages.filter(Boolean);
  return both(parts.map((m) => m.en).join(' '), parts.map((m) => m.fr).join(' '));
};

/** "45 s" / "25 min" / "3 h", for the waits. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [F.SPEED]: both('Fan speed (0 = off)', 'Vitesse du ventilateur (0 = arrêt)'),
  [F.DIRECTION]: both('Direction', 'Sens de rotation'),
  [F.WIND]: both('Breeze mode', 'Mode brise'),
  [F.LIGHT]: both('Light', 'Lumière'),
  [F.BRIGHTNESS]: both('Brightness', 'Intensité'),
};

export const OPTION_NAMES = {
  forward: both('Forward (summer)', 'Avant (été)'),
  reverse: both('Reverse (winter)', 'Inverse (hiver)'),
  windOff: both('Off', 'Arrêt'),
  breeze: both('Breeze', 'Brise'),
};

/** The id shown to the user: the last 6 hex digits, as the fan's own Wi-Fi name has them. */
export const shortId = (id) => id.slice(-6).toUpperCase();

/** The name of a fan: its name in the Modern Forms app, else "Modern Forms fan ABCDEF". */
export function fanName(fan, language) {
  if (fan.info?.name) return fan.info.name;
  return word(
    both(`Modern Forms fan ${shortId(fan.id)}`, `Ventilateur Modern Forms ${shortId(fan.id)}`),
    language,
  );
}

export const PART_NAMES = {
  [PARTS.FAN]: both('fan', 'ventilateur'),
  [PARTS.LIGHT]: both('light', 'lumière'),
};

/** The reason of a failure, in each language. */
export function reasonOf(err) {
  const status = err?.status ? ` (HTTP ${err.status})` : '';
  switch (err?.code) {
    case 'network':
      return both(`no connection (${err.message})`, `pas de connexion (${err.message})`);
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'late':
      return both('no time left to send', 'plus le temps d’envoyer');
    case 'cut':
      return both('interrupted', 'interrompue');
    case 'busy':
      return both(`the fan asks to wait${status}`, `le ventilateur demande d’attendre${status}`);
    case 'http':
      if (err.status === 404) {
        return both(
          'no /mf API (HTTP 404): a generation 4 fan is not handled yet',
          'pas d’API /mf (HTTP 404) : un ventilateur de 4e génération n’est pas encore géré',
        );
      }
      return both(`unexpected answer${status}`, `réponse inattendue${status}`);
    case 'size':
      return both('answer too large', 'réponse trop grande');
    case 'bad_response':
      return both('not a Modern Forms answer', 'pas une réponse Modern Forms');
    default:
      return both('internal error', 'erreur interne');
  }
}

export const T = {
  connecting: both('Connecting to the fans…', 'Connexion aux ventilateurs…'),
  noFans: both(
    'Enter the address of your fans (one per line or separated by commas).',
    'Saisissez l’adresse de vos ventilateurs (une par ligne ou séparées par des virgules).',
  ),
  addressErrors: (list) =>
    both(`Addresses not understood: ${list}.`, `Adresses non comprises : ${list}.`),
  tooMany: (max) =>
    both(
      `Only the first ${max} addresses are read.`,
      `Seules les ${max} premières adresses sont lues.`,
    ),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; new try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  read: (names) => both(`Read: ${names}.`, `Lus : ${names}.`),
  unreachable: (address, reason, wait) =>
    both(
      `${address}: unreachable (${reason.en}), next try in ${wait.en}.`,
      `${address} : injoignable (${reason.fr}), nouvel essai dans ${wait.fr}.`,
    ),
  waiting: (address) => both(`${address}: not read yet.`, `${address} : pas encore lu.`),
  noIdentity: (address) =>
    both(
      `${address}: answers without the identity of a fan (clientId): nothing published, no command but Offs.`,
      `${address} : répond sans l’identité d’un ventilateur (clientId) : rien de publié, aucune commande hormis les arrêts.`,
    ),
  duplicate: (address, other) =>
    both(
      `${address}: the same fan as ${other} (typed twice).`,
      `${address} : le même ventilateur que ${other} (saisi deux fois).`,
    ),
  toAdd: (n) =>
    both(`${n} fan(s) to add in Discover.`, `${n} ventilateur(s) à ajouter dans Découverte.`),
  guardPending: (name, part, sends) =>
    both(
      `Off of the ${part.en} of ${name}: not seen applied yet (sent again ${sends} time(s)), still held.`,
      `Arrêt de la ${part.fr === 'ventilateur' ? 'rotation' : 'lumière'} de ${name} : pas encore vu appliqué (renvoyé ${sends} fois), toujours gardé.`,
    ),
  guardExhausted: (name, part) =>
    both(
      `Off of the ${part.en} of ${name}: accepted 3 more times by the fan, still on; held, click Off again to retry.`,
      `Arrêt de la ${part.fr === 'ventilateur' ? 'rotation' : 'lumière'} de ${name} : accepté 3 fois de plus par le ventilateur, toujours en marche ; gardé, recliquez sur Arrêt pour réessayer.`,
    ),
  storeProblem: both(
    '/data could not be written: the Offs held are kept in memory only.',
    '/data n’a pas pu être écrit : les arrêts gardés le sont en mémoire seulement.',
  ),
  storeUnreadable: both(
    '/data could not be read: nothing is written over it until it reads again.',
    '/data n’a pas pu être lu : rien n’est écrit par-dessus tant qu’il ne se relit pas.',
  ),
  test: {
    none: both(
      'No fan address in the configuration.',
      'Aucune adresse de ventilateur dans la configuration.',
    ),
    ok: (address, name, summary) =>
      both(`${address}: ${name}, ${summary.en}.`, `${address} : ${name}, ${summary.fr}.`),
    recent: (address, name, summary, ago) =>
      both(
        `${address}: ${name}, ${summary.en} (read ${ago.en} ago).`,
        `${address} : ${name}, ${summary.fr} (lu il y a ${ago.fr}).`,
      ),
    failed: (address, reason) =>
      both(`${address}: failed (${reason.en}).`, `${address} : échec (${reason.fr}).`),
    noIdentity: (address) =>
      both(
        `${address}: answers, but not as a Modern Forms fan (no clientId).`,
        `${address} : répond, mais pas comme un ventilateur Modern Forms (pas de clientId).`,
      ),
  },
};

/** "fan off, light on 40 %". */
export function summaryOf(state) {
  const fan =
    state.fan.on === true
      ? both(
          `fan on (speed ${state.fan.speed ?? '?'})`,
          `ventilateur en marche (vitesse ${state.fan.speed ?? '?'})`,
        )
      : state.fan.on === false
        ? both('fan off', 'ventilateur arrêté')
        : both('fan unknown', 'ventilateur inconnu');
  if (!state.light.present) return fan;
  const pct = state.light.brightness === undefined ? '' : ` ${state.light.brightness} %`;
  const light = state.light.on
    ? both(`light on${pct}`, `lumière allumée${pct}`)
    : both('light off', 'lumière éteinte');
  return both(`${fan.en}, ${light.en}`, `${fan.fr}, ${light.fr}`);
}

export const ERRORS = {
  notCommandable: both(
    'This feature cannot be driven.',
    'Cette fonctionnalité ne peut pas être pilotée.',
  ),
  badValue: both('Invalid value.', 'Valeur invalide.'),
  configNotLoaded: both(
    'The configuration has not been read from Gladys yet: nothing was sent.',
    'La configuration n’a pas encore été lue depuis Gladys : rien n’a été envoyé.',
  ),
  addressUnknown: both(
    'The address of this fan is not known (never read, several addresses typed): nothing was sent.',
    'L’adresse de ce ventilateur n’est pas connue (jamais lu, plusieurs adresses saisies) : rien n’a été envoyé.',
  ),
  notConfigured: both(
    'This fan is not at an address of the configuration: nothing was sent.',
    'Ce ventilateur n’est pas à une adresse de la configuration : rien n’a été envoyé.',
  ),
  otherFan: (address) =>
    both(
      `Another fan answers at ${address}: nothing was sent.`,
      `Un autre ventilateur répond à ${address} : rien n’a été envoyé.`,
    ),
  noIdentity: (address) =>
    both(
      `The device at ${address} does not say which fan it is: nothing was sent.`,
      `L’appareil à ${address} ne dit pas quel ventilateur il est : rien n’a été envoyé.`,
    ),
  answeredByOther: (address) =>
    both(
      `Sent, but another fan answered at ${address}: check the addresses.`,
      `Envoyé, mais un autre ventilateur a répondu à ${address} : vérifiez les adresses.`,
    ),
  notSupported: both(
    'This fan does not have this function.',
    'Ce ventilateur n’a pas cette fonction.',
  ),
  paused: (reason, wait) =>
    both(
      `The fan is unreachable (${reason.en}); next try in ${wait.en}: nothing was sent.`,
      `Le ventilateur est injoignable (${reason.fr}) ; nouvel essai dans ${wait.fr} : rien n’a été envoyé.`,
    ),
  stopPending: both(
    'An Off is being sent to this fan: nothing was sent.',
    'Un arrêt est en cours d’envoi à ce ventilateur : rien n’a été envoyé.',
  ),
  cancelledByStop: both(
    'Cancelled by a newer command (an Off): nothing was sent.',
    'Annulée par une commande plus récente (un arrêt) : rien n’a été envoyé.',
  ),
  queueFull: both(
    'Too many commands waiting for this fan: nothing was sent.',
    'Trop de commandes en attente pour ce ventilateur : rien n’a été envoyé.',
  ),
  late: (ahead) =>
    both(
      `Not sent in time (${ahead} command(s) ahead): nothing was sent.`,
      `Pas envoyée à temps (${ahead} commande(s) avant) : rien n’a été envoyé.`,
    ),
  restarting: both(
    'The integration is restarting: nothing was sent.',
    'L’intégration redémarre : rien n’a été envoyé.',
  ),
  notSent: (reason) =>
    both(`Nothing was sent (${reason.en}).`, `Rien n’a été envoyé (${reason.fr}).`),
  rejected: (reason) =>
    both(
      `The fan refused the command (${reason.en}).`,
      `Le ventilateur a refusé la commande (${reason.fr}).`,
    ),
  unconfirmed: both(
    'Sent, without confirmation: the fan is read again in 5 s.',
    'Envoyée, sans confirmation : le ventilateur est relu dans 5 s.',
  ),
  notApplied: both(
    'Sent, but the fan does not show it yet: it is read again in 5 s.',
    'Envoyée, mais le ventilateur ne l’affiche pas encore : il est relu dans 5 s.',
  ),
  protectiveKept: (reason) =>
    both(
      `Off not sent yet (${reason.en}): kept, and sent as soon as the fan answers.`,
      `Arrêt pas encore envoyé (${reason.fr}) : gardé, et envoyé dès que le ventilateur répond.`,
    ),
  offNotApplied: both(
    'Off sent, but the fan does not show it yet: held, and sent again by the next reads.',
    'Arrêt envoyé, mais le ventilateur ne l’affiche pas encore : gardé, et renvoyé par les prochaines lectures.',
  ),
  offUnconfirmed: both(
    'Off sent, without confirmation: held, and sent again by the next reads if they contradict it.',
    'Arrêt envoyé, sans confirmation : gardé, et renvoyé par les prochaines lectures si elles le contredisent.',
  ),
};
