// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, button, errors). Errors
// thrown to Gladys are English (one language per message, like the core's);
// the statuses and button answers are { en, fr }. No text ever holds the
// e-mail address, the password, a tracker name or a position.
// -----------------------------------------------------------------------------

import { CODES } from './paj/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
/** French: 0 and 1 take the singular. */
const pluralFr = (n, one, many) => (n <= 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/** A delay in words: minutes below 1 h, hours above. */
export const delayText = (ms) => {
  const m = minutes(ms);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
};

/** Why a reading failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large (above 1 MB)', fr: 'réponse trop grande (plus de 1 Mo)' };
    case CODES.TLS_UNTRUSTED:
      return { en: 'certificate not trusted', fr: 'certificat non reconnu' };
    case CODES.SESSION:
      return {
        en: 'the new session was refused again',
        fr: 'la nouvelle session a encore été refusée',
      };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    case 'internal':
      return {
        en: 'internal error of the integration (see its logs)',
        fr: 'erreur interne de l’intégration (voir ses journaux)',
      };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

export const T = {
  status: {
    ok: ({ total, capped, at, next, home }) => ({
      en: [
        `PAJ GPS answers: ${total} ${plural(total, 'tracker', 'trackers')}, read at ${at}, next reading at ${next}.`,
        capped > 0
          ? `${capped} more ${plural(capped, 'tracker is', 'trackers are')} left out (20 at most).`
          : '',
        home ? '' : 'No house of Gladys has a position: no distance to home (Settings > Houses).',
      ]
        .filter(Boolean)
        .join(' '),
      fr: [
        `PAJ GPS répond : ${total} ${pluralFr(total, 'traceur', 'traceurs')}, lu à ${at}, prochaine lecture à ${next}.`,
        capped > 0
          ? `${capped} ${pluralFr(capped, 'autre traceur est ignoré', 'autres traceurs sont ignorés')} (20 au plus).`
          : '',
        home
          ? ''
          : 'Aucune maison de Gladys n’a de position : pas de distance au domicile (Paramètres > Maisons).',
      ]
        .filter(Boolean)
        .join(' '),
    }),
    noDevice: (next) => ({
      en: `PAJ GPS answers, but the account has no tracker. Next reading at ${next}.`,
      fr: `PAJ GPS répond, mais le compte n’a aucun traceur. Prochaine lecture à ${next}.`,
    }),
    waiting: (next) => ({
      en: `Waiting for the next reading at ${next}: PAJ GPS is never read more often than the refresh interval.`,
      fr: `En attente de la prochaine lecture à ${next} : PAJ GPS n’est jamais lu plus souvent que l’intervalle de rafraîchissement.`,
    }),
    configUnreadable: {
      en: 'Gladys did not give the configuration of the integration: read again in 1 min.',
      fr: 'Gladys n’a pas transmis la configuration de l’intégration : nouvelle lecture dans 1 min.',
    },
    missingCredentials: {
      en: 'Type the e-mail address and the password of your PAJ GPS account (the ones of the PAJ app or of connect.paj-gps.de).',
      fr: 'Saisissez l’adresse e-mail et le mot de passe de votre compte PAJ GPS (ceux de l’application PAJ ou de connect.paj-gps.de).',
    },
    emailInvalid: {
      en: 'The e-mail address is not one (or holds a line break): type it again. Nothing was sent.',
      fr: 'L’adresse e-mail n’en est pas une (ou contient un retour à la ligne) : saisissez-la de nouveau. Rien n’a été envoyé.',
    },
    passwordInvalid: {
      en: 'The password holds a line break or a control character (pasted?): type it again. Nothing was sent.',
      fr: 'Le mot de passe contient un retour à la ligne ou un caractère de contrôle (collé ?) : saisissez-le de nouveau. Rien n’a été envoyé.',
    },
    refused: (status) => ({
      en: `PAJ GPS refused the e-mail address or the password${status ? ` (HTTP ${status})` : ''}: nothing more is sent with them. Check them on connect.paj-gps.de, then save the configuration, or click "Test the connection" (one try, no sooner than the refresh interval).`,
      fr: `PAJ GPS a refusé l’adresse e-mail ou le mot de passe${status ? ` (HTTP ${status})` : ''} : plus rien n’est envoyé avec eux. Vérifiez-les sur connect.paj-gps.de, puis enregistrez la configuration, ou cliquez sur « Tester la connexion » (un essai, pas avant la fin de l’intervalle de rafraîchissement).`,
    }),
    loginNotFound: {
      en: 'Unexpected answer of the PAJ GPS API: its login route was not found (HTTP 404; the API may have changed). Not about the credentials. No new try by itself: update the integration, or click "Test the connection" (one try, no sooner than the refresh interval).',
      fr: 'Réponse inattendue de l’API PAJ GPS : sa route de connexion est introuvable (HTTP 404 ; l’API a peut-être changé). Rien à voir avec les identifiants. Aucun nouvel essai automatique : mettez à jour l’intégration, ou cliquez sur « Tester la connexion » (un essai, pas avant la fin de l’intervalle de rafraîchissement).',
    },
    busy: (status, delay) => ({
      en: `PAJ GPS asked Gladys to wait (HTTP ${status ?? 429}): every request is paused for ${delayText(delay)}.`,
      fr: `PAJ GPS a demandé à Gladys d’attendre (HTTP ${status ?? 429}) : toutes les requêtes sont suspendues pendant ${delayText(delay)}.`,
    }),
    forbidden: (delay) => ({
      en: `Access refused (HTTP 403) by something else than the PAJ GPS API (a firewall, a proxy?): paused for ${delayText(delay)}. Not about the credentials.`,
      fr: `Accès refusé (HTTP 403) par autre chose que l’API PAJ GPS (un pare-feu, un proxy ?) : en pause pendant ${delayText(delay)}. Rien à voir avec les identifiants.`,
    }),
    failed: (err, next) => {
      const reason = reasonOf(err);
      return {
        en: `Reading PAJ GPS failed: ${reason.en}. Next try at ${next}.`,
        fr: `Lecture de PAJ GPS échouée : ${reason.fr}. Nouvel essai à ${next}.`,
      };
    },
  },
  test: {
    read: (status) => ({ en: `Read now. ${status.en}`, fr: `Lu à l’instant. ${status.fr}` }),
    notDue: (status) => ({
      en: `Not read again: the refresh interval since the last attempt is kept. ${status.en}`,
      fr: `Pas de nouvelle lecture : l’intervalle de rafraîchissement depuis la dernière tentative est respecté. ${status.fr}`,
    }),
  },
  errors: {
    readOnly: 'This integration only reads PAJ GPS: nothing can be changed from Gladys',
    testTooLong:
      'PAJ GPS has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
