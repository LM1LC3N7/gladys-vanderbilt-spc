// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. The connection status and the button answers
// are { en, fr }; errors thrown to Gladys are English (one language per
// message, like the core's); the device names follow the language chosen in
// the configuration. Never a credential, never the text of an answer.
// -----------------------------------------------------------------------------

import { CODES } from './spc/errors.js';

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.round(ms / 1000));

/** A word in the configured language ({ en, fr } or a function of the number). */
export const word = (entry, language) => entry?.[language] ?? entry?.en;

export const DEVICE_NAMES = {
  panel: { en: 'SPC panel', fr: 'Centrale SPC' },
  area: { en: (id) => `Area ${id}`, fr: (id) => `Secteur ${id}` },
  zone: { en: (id) => `Zone ${id}`, fr: (id) => `Zone ${id}` },
};

export const FEATURE_NAMES = {
  online: { en: 'Gateway link', fr: 'Lien avec la passerelle' },
  mode: { en: 'Mode', fr: 'Mode' },
  armed: { en: 'Armed', fr: 'Armé' },
  alarm: { en: 'Alarm', fr: 'Alarme' },
  'arm-full': { en: 'Full set', fr: 'Mise en service totale' },
  'arm-part-a': { en: 'Part set A', fr: 'Mise en service partielle A' },
  'arm-part-b': { en: 'Part set B', fr: 'Mise en service partielle B' },
  disarm: { en: 'Unset (disarm)', fr: 'Mise hors service (désarmer)' },
  'zone-trouble': { en: 'Trouble', fr: 'Défaut' },
  'zone-bypass': { en: 'Inhibited or isolated', fr: 'Inhibée ou isolée' },
  'zone-alarm': { en: 'Alarm', fr: 'Alarme' },
  kind: {
    opening: { en: 'Opening', fr: 'Ouverture' },
    motion: { en: 'Motion', fr: 'Mouvement' },
    smoke: { en: 'Smoke', fr: 'Fumée' },
    leak: { en: 'Water leak', fr: 'Fuite d’eau' },
    input: { en: 'Input', fr: 'Entrée' },
  },
};

export const MODE_NAMES = {
  unset: { en: 'Unset', fr: 'Hors service' },
  part_set_a: { en: 'Part set A', fr: 'Partielle A' },
  part_set_b: { en: 'Part set B', fr: 'Partielle B' },
  full_set: { en: 'Full set', fr: 'Totale' },
  alarm: { en: 'Alarm', fr: 'Alarme' },
  unknown: { en: 'Unknown', fr: 'Inconnu' },
};

/** Why the gateway failed, in a few words (codes and statuses only). */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.RESET:
      return { en: 'connection closed by the gateway', fr: 'connexion fermée par la passerelle' };
    case CODES.TIMEOUT:
    case CODES.NOT_SENT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.FAILED:
      return { en: 'the gateway reports a failure', fr: 'la passerelle signale un échec' };
    case CODES.CUT:
      return { en: 'request cut', fr: 'requête coupée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const EMPTY = { en: '', fr: '' };

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({
      areas,
      zones,
      events,
      eventsStatus,
      zonesUnread,
      identityUnread,
      zoneKindsInvalid,
      unwritable,
      basic,
      notices = [],
    }) =>
      join(
        {
          en: `The gateway answers: ${areas} area(s), ${zones} zone(s).`,
          fr: `La passerelle répond : ${areas} secteur(s), ${zones} zone(s).`,
        },
        {
          live: {
            en: 'Live events received.',
            fr: 'Événements reçus en direct.',
          },
          down: {
            en: 'Live events not received (websocket closed): read every minute.',
            fr: 'Événements non reçus en direct (websocket fermé) : lecture toutes les minutes.',
          },
          refused: {
            en: 'The websocket of the gateway refuses the connection: read every minute only.',
            fr: 'Le websocket de la passerelle refuse la connexion : lecture toutes les minutes seulement.',
          },
        }[events] ?? EMPTY,
        events === 'down' && eventsStatus
          ? {
              en: `The websocket answers HTTP ${eventsStatus} at /ws/spc (path not checked on a real gateway).`,
              fr: `Le websocket répond HTTP ${eventsStatus} à /ws/spc (chemin non vérifié sur une vraie passerelle).`,
            }
          : EMPTY,
        basic
          ? {
              en: 'Basic authentication: the user name and the password are readable by anyone listening on your local network, at every read.',
              fr: 'Authentification Basic : l’identifiant et le mot de passe sont lisibles par quiconque écoute votre réseau local, à chaque lecture.',
            }
          : EMPTY,
        ...notices,
        zonesUnread
          ? {
              en: 'The zones could not be read at the last read.',
              fr: 'Les zones n’ont pas pu être lues à la dernière lecture.',
            }
          : EMPTY,
        identityUnread
          ? {
              en: 'The serial number of the panel is not read yet: unsetting waits for it (setting is not held back).',
              fr: 'Le numéro de série de la centrale n’est pas encore lu : la mise hors service l’attend (la mise en service n’est pas retenue).',
            }
          : EMPTY,
        zoneKindsInvalid
          ? {
              en: `${zoneKindsInvalid} entry(ies) of "Zone kinds" not understood (expected: number:kind).`,
              fr: `${zoneKindsInvalid} entrée(s) de « Types des zones » non comprise(s) (attendu : numéro:type).`,
            }
          : EMPTY,
        unwritable
          ? {
              en: 'The data of the integration (/data) cannot be written.',
              fr: 'Les données de l’intégration (/data) ne peuvent pas être écrites.',
            }
          : EMPTY,
      ),
    hostEmpty: {
      en: 'Enter the address of the SPC Web Gateway.',
      fr: 'Indiquez l’adresse de la SPC Web Gateway.',
    },
    hostInvalid: {
      en: 'The address of the gateway is not valid (IP address or name, with an optional port).',
      fr: 'L’adresse de la passerelle n’est pas valide (adresse IP ou nom, port facultatif).',
    },
    hostCredentials: {
      en: 'The address must not carry a user name or a password: use the fields below.',
      fr: 'L’adresse ne doit pas contenir d’identifiant ni de mot de passe : utilisez les champs plus bas.',
    },
    hostHttps: {
      en: 'Enter the address without https:// (the integration speaks plain http to the gateway on your network).',
      fr: 'Indiquez l’adresse sans https:// (l’intégration parle en http simple à la passerelle sur votre réseau).',
    },
    credentials: (error) =>
      ({
        password_alone: {
          en: 'A password is given without a user name: fill both, or neither.',
          fr: 'Un mot de passe est donné sans identifiant : remplissez les deux, ou aucun.',
        },
        username_alone: {
          en: 'A user name is given without a password: fill both, or neither.',
          fr: 'Un identifiant est donné sans mot de passe : remplissez les deux, ou aucun.',
        },
        characters: {
          en: 'The user name or the password holds a character that cannot be sent (control character, or ":" in the user name).',
          fr: 'L’identifiant ou le mot de passe contient un caractère qui ne peut pas être envoyé (caractère de contrôle, ou « : » dans l’identifiant).',
        },
      })[error] ?? {
        en: 'The user name or the password is too long.',
        fr: 'L’identifiant ou le mot de passe est trop long.',
      },
    dataUnreadable: {
      en: 'The data of the integration (/data) cannot be read: no read of the gateway (it would overwrite them); setting an area still works. Tried again every minute.',
      fr: 'Les données de l’intégration (/data) sont illisibles : pas de lecture de la passerelle (elle les écraserait) ; la mise en service d’un secteur fonctionne toujours. Nouvel essai toutes les minutes.',
    },
    configNotRead: (delay) => ({
      en: `The configuration of Gladys is not read yet. Asked again in ${minutes(delay)} min.`,
      fr: `La configuration de Gladys n’est pas encore lue. Nouvel essai dans ${minutes(delay)} min.`,
    }),
    connecting: {
      en: 'Connecting to the gateway…',
      fr: 'Connexion à la passerelle…',
    },
    authRequired: {
      en: 'The gateway asks for a user name and a password: fill them in the configuration. No new try until then (or "Test the connection").',
      fr: 'La passerelle demande un identifiant et un mot de passe : renseignez-les dans la configuration. Pas de nouvel essai d’ici là (ou « Tester la connexion »).',
    },
    authUnsupported: {
      en: 'The gateway asks for an authentication this integration does not know (neither Digest nor Basic). No new try until the configuration changes (or "Test the connection").',
      fr: 'La passerelle demande une authentification que l’intégration ne connaît pas (ni Digest ni Basic). Pas de nouvel essai avant un changement de configuration (ou « Tester la connexion »).',
    },
    authBasic: {
      en: 'The gateway asks for Basic authentication: the password would be readable on your local network. Nothing sent. Tick "Allow Basic authentication" if you accept it.',
      fr: 'La passerelle demande une authentification Basic : le mot de passe serait lisible sur votre réseau local. Rien n’est envoyé. Cochez « Autoriser l’authentification Basic » si vous l’acceptez.',
    },
    authDowngrade: {
      en: 'The gateway now asks for Basic authentication after Digest worked (the password would be readable on the network): nothing sent. Check the gateway, then press "Test the connection".',
      fr: 'La passerelle demande maintenant une authentification Basic alors que Digest marchait (le mot de passe serait lisible sur le réseau) : rien n’est envoyé. Vérifiez la passerelle, puis appuyez sur « Tester la connexion ».',
    },
    authRefused: {
      en: 'The gateway refuses the user name or the password. No new read with them: enter other ones (or press "Test the connection" for one try).',
      fr: 'La passerelle refuse l’identifiant ou le mot de passe. Plus de lecture avec ceux-ci : saisissez-en d’autres (ou appuyez sur « Tester la connexion » pour un essai).',
    },
    otherPanel: (serial) => ({
      en: `Another panel answers at this address (serial ${serial}): nothing is published nor sent. If it is yours (a panel replaced), press "Use the panel that answers".`,
      fr: `Une autre centrale répond à cette adresse (numéro de série ${serial}) : rien n’est publié ni envoyé. Si c’est la vôtre (centrale remplacée), appuyez sur « Utiliser la centrale qui répond ».`,
    }),
    unreachable: (err, delay) =>
      join(
        {
          en: `The gateway does not answer (${reasonOf(err).en}).`,
          fr: `La passerelle ne répond pas (${reasonOf(err).fr}).`,
        },
        RETRY(delay),
      ),
    notGateway: (delay) =>
      join(
        {
          en: 'This address does not answer like an SPC Web Gateway (check the address and the port, 8088 by default).',
          fr: 'Cette adresse ne répond pas comme une SPC Web Gateway (vérifiez l’adresse et le port, 8088 par défaut).',
        },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ areas, zones, ago }) => ({
      en: `The gateway answers: ${areas} area(s), ${zones} zone(s) (last read ${seconds(ago)} s ago).`,
      fr: `La passerelle répond : ${areas} secteur(s), ${zones} zone(s) (dernière lecture il y a ${seconds(ago)} s).`,
    }),
    wait: (left) => ({
      en: `Not read again sooner than every minute: next read in ${seconds(left)} s.`,
      fr: `Pas de relecture plus souvent qu’une fois par minute : prochaine lecture dans ${seconds(left)} s.`,
    }),
    accepted: (serial) => ({
      en: `The panel ${serial} is now the one this integration drives.`,
      fr: `La centrale ${serial} est désormais celle que pilote l’intégration.`,
    }),
  },
  notices: {
    notVisible: ({ area, mode, when }) => ({
      en: `The ${MODE_NAMES[mode].en} of area ${area} asked at ${when} UTC was accepted by the gateway but the area does not show it 60 s later (exit time, a zone open, or cancelled at the keypad): not sent again.`,
      fr: `La mise en service ${MODE_NAMES[mode].fr} du secteur ${area} demandée à ${when} UTC a été acceptée par la passerelle mais le secteur ne la montre pas 60 s plus tard (temporisation de sortie, zone ouverte, ou annulée au clavier) : pas renvoyée.`,
    }),
    neverLeft: ({ area, mode, when }) => ({
      en: `The ${MODE_NAMES[mode].en} of area ${area} asked at ${when} UTC never reached the gateway: set it again.`,
      fr: `La mise en service ${MODE_NAMES[mode].fr} du secteur ${area} demandée à ${when} UTC n’a jamais atteint la passerelle : refaites-la.`,
    }),
    moved: ({ area, mode, when }) => ({
      en: `The ${MODE_NAMES[mode].en} of area ${area} asked at ${when} UTC did not reach the gateway, and the area changed at the panel since (or was not read before): not sent again.`,
      fr: `La mise en service ${MODE_NAMES[mode].fr} du secteur ${area} demandée à ${when} UTC n’a pas atteint la passerelle, et le secteur a changé à la centrale depuis (ou n’avait pas été lu avant) : pas renvoyée.`,
    }),
  },
  errors: {
    readOnly: 'This feature is read-only',
    badValue: 'Value refused: a button takes 1 only',
    notConfigured: 'The gateway is not configured (see the status of the integration)',
    configNotReadYet:
      'The configuration of Gladys is not read yet (asked again): nothing sent, try again in a moment',
    authBasic:
      'The gateway asks for Basic authentication, not allowed in the configuration: nothing sent',
    authDowngrade:
      'The gateway now asks for Basic authentication after Digest worked: nothing sent (see the status)',
    authUnsupported:
      'The gateway asks for an authentication this integration does not know: nothing sent',
    configChanged: 'The configuration changed meanwhile: nothing sent',
    authRefused:
      'The gateway refuses the user name or the password: command not applied (enter other ones in the configuration, then "Test the connection")',
    authRequired:
      'The gateway asks for a user name and a password: command not applied (fill them in the configuration)',
    otherPanel:
      'Another panel answers at this address: nothing sent (see the status of the integration)',
    disarmDisabled:
      'Unsetting from Gladys is disabled (tick "Allow unsetting (disarming)" in the configuration)',
    identityUnknown:
      'The serial number of the panel is not read yet since the start: unsetting refused, nothing sent (try again after the next read, within a minute)',
    identityNow:
      'The serial number of the panel could not be read now, or another panel answers: unsetting refused, nothing sent',
    tooManyDisarms: (n) => `Refused: at most ${n} unset commands per area and per minute`,
    disarmWithdrawn: 'Withdrawn: a set command of this area was asked after it, nothing sent',
    busy: 'Earlier commands of this area took all the time: nothing sent, try again',
    stateUnknown: (err) => `State of the area not read (${reasonOf(err).en}): nothing sent`,
    partStateUnknown: (err) =>
      `State of the area not read (${reasonOf(err).en}): a part set could lower a full set, nothing sent (a full set is never held back by this)`,
    otherPartSet: (current) =>
      `The area is in ${MODE_NAMES[current].en}: nothing sent (a part set never replaces the other one; full set, or unset first)`,
    refusedByGateway: (status) => `Sent, refused by the gateway (HTTP ${status}): not sent again`,
    refusedByPanel:
      'Sent, refused by the panel (the gateway reports a failure: a zone open or in fault, for instance)',
    armNotSent: (err) =>
      `Not sent: the gateway did not take the request (${reasonOf(err).en}); sent again within 2 minutes only if a fresh read shows nothing changed at the panel`,
    armNoAnswer: (err) =>
      `Sent, no valid answer from the gateway (${reasonOf(err).en}): area read again 5, 20 and 60 s later; sent again within 2 minutes only if nothing changed at the panel`,
    armReplaced: 'Not sent: an unset command of this area, asked after it, left first',
    unconfirmed: (what) =>
      `Sent and accepted by the gateway, not yet shown by the area (${what}): read again 5, 20 and 60 s later, not sent again`,
    disarmUnconfirmed:
      'Sent and accepted by the gateway, the area does not show it unset yet: read again 5 and 20 s later',
    disarmNotSent: (err) => `Not sent (${reasonOf(err).en})`,
    disarmNoAnswer: (err) =>
      `Sent, no answer from the gateway (${reasonOf(err).en}): read again 5 and 20 s later`,
    testTooLong: 'The gateway did not answer in time',
    configNotRead: 'The configuration of Gladys could not be read: try again in a moment',
    nothingToAccept: 'No other panel is answering: nothing to accept',
  },
};
