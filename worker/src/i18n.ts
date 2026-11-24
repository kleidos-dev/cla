// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * Every string of the site, in English and Spanish, and how a request's
 * language is chosen. The English texts of the agreement are the binding
 * ones; the Spanish pages say so and render the informative translations.
 * Strings with inline HTML are the site's own, never user input: anything
 * from a request or from GitHub goes through escapeHtml where it is used.
 */
export type Lang = "en" | "es";

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "es";
}

/**
 * `?lang=` wins, then the first of es/en in Accept-Language, then English.
 * No cookie remembers the choice: the site's links carry `?lang=`, and the
 * sign-in carries it through GitHub in the transaction it already keeps.
 */
export function pickLang(req: Request, url: URL): Lang {
  const q = url.searchParams.get("lang");
  if (isLang(q)) return q;
  return fromAcceptLanguage(req.headers.get("accept-language"));
}

export function fromAcceptLanguage(header: string | null): Lang {
  if (!header) return "en";
  const ranked = header
    .split(",")
    .slice(0, 20)
    .map((part) => {
      // String.prototype.split always gives at least one piece.
      const [tag, ...params] = part.trim().split(";") as [string, ...string[]];
      const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qp ? Number(qp.slice(2)) : 1;
      return { base: (tag.trim().toLowerCase().split("-") as [string, ...string[]])[0], q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.q > 0 && (x.base === "en" || x.base === "es"))
    // Array.prototype.sort is stable: of equal weights, the first listed stays first.
    .sort((a, b) => b.q - a.q);
  return ranked[0]?.base === "es" ? "es" : "en";
}

type Pair = readonly [string, string];

export interface Strings {
  skip: string;
  brandName: string;
  brandSub: string;
  langNav: string;
  steps: readonly [string, string, string];
  footer: readonly Pair[];
  prLabel: string;
  start: {
    title: string;
    where: string;
    h1: string;
    lede: string;
    stillLabel: string;
    nobody: string;
    button: string;
    buttonAgain: string;
    note: string;
    links: readonly Pair[];
    ghSummary: string;
    /** What GitHub shows for kleidos-cla, the sign-in of a "comment" version (version 1). */
    ghBody: string;
    /** What GitHub shows for the identity-only sign-in app, the sign-in of a "signin" version. */
    ghBodySignin: string;
    whoSummary: string;
    whoBody: string;
  };
  accept: {
    title: string;
    where: string;
    signedInAs: string;
    switch: string;
    signOut: string;
    h1: string;
    summaryLabel: string;
    summary: readonly Pair[];
    button: string;
    note: (login: string, pr: string) => string;
    noteSignin: (login: string, pr: string) => string;
    translation: { summary: string; body: (short: string, version: number) => string } | null;
    error: string;
    foldTitle: string;
    foldSub: (version: number) => string;
    binding: string | null;
    backbar: string;
    backLink: string;
    beforeTitle: string;
    before: readonly string[];
    beforeSignin: readonly string[];
    data: string;
    dataSignin: string;
  };
  done: {
    titleRecording: string;
    titleRecorded: string;
    whereRecording: string;
    whereRecorded: string;
    h1: string;
    lede: (pr: string) => string;
    statusRecording: string;
    statusRecorded: string;
    account: string;
    accountValue: (login: string, id: number) => string;
    version: string;
    accepted: string;
    comment: string;
    entry: string;
    entryRecording: string;
    checkNow: string;
    back: string;
    keep: string;
    checks: string;
  };
  status: {
    title: string;
    signedTitle: string;
    signed: (version: number, date: string) => string;
    entry: string;
    nothingTitle: string;
    exempt: (login: string) => string;
    entity: (login: string, entity: string) => string;
    notAuthor: (login: string) => string;
    notUserTitle: string;
    notUser: (login: string) => string;
    paused: string;
    edited: string;
    recordFailed: string;
  };
  agreement: {
    title: string;
    entityTitle: string;
    eyebrow: (version: number) => string;
    h1: string;
    entityH1: string;
    lede: string;
    how: string;
    entity: string;
    entityNote: string;
    entityOnlyEnglish: string | null;
    toc: string;
    partA: string;
    partB: string;
    partSummary: string;
    partSummarySub: string;
    banner: string | null;
  };
  privacy: { title: string; eyebrow: string };
  meta: (version: number, sha: string) => string;
  downloads: string;
  notConfigured: string;
}

const EN: Strings = {
  skip: "Skip to the content",
  brandName: "Kleidos",
  brandSub: "Contributor Agreement",
  langNav: "Language",
  steps: ["Step 1 of 2 · Sign in", "Step 2 of 2 · Accept", "Done · Signed"],
  footer: [
    ["The agreement", "/agreement"],
    ["Privacy notice", "/privacy"],
    ["Register and source", "https://github.com/kleidos-dev/cla"],
    ["mail@kleidos.dev", "mailto:mail@kleidos.dev"],
  ],
  prLabel: "Pull request",
  start: {
    title: "Sign the Kleidos Contributor Agreement",
    where: "<strong>Nothing is signed yet.</strong> Sign in first; you accept on the next page.",
    h1: "Sign the Kleidos Contributor Agreement",
    lede: "Everyone who contributes to Kleidos accepts this agreement once; it then covers every Kleidos repository. You keep your copyright.",
    stillLabel: "Still to sign",
    nobody: "Nobody: every author has signed",
    button: "Sign in with GitHub to sign",
    buttonAgain: "Sign in with GitHub again to sign",
    note: "Signing in only tells us who you are. You read the summary and sign on the next page.",
    links: [
      ["Read the agreement", "/agreement"],
      ["Privacy notice", "/privacy"],
    ],
    ghSummary: "What GitHub will show you",
    ghBody:
      "GitHub asks you to authorize <strong>kleidos-cla</strong>, by kleidos-dev, and lists “Verify your GitHub identity”, “Know which resources you can access” and “Act on your behalf”. GitHub writes those lines for every GitHub App, and adds how recently the app was created and how many people use it. kleidos-cla reads your account id and login, and posts one comment on this pull request only when you click “I agree and sign”. Its permission is withdrawn as soon as that is done.",
    ghBodySignin:
      "GitHub asks you to authorize <strong>Kleidos CLA sign-in</strong>, by kleidos-dev: a separate app with no permission at all, used only to tell us which account you are. It gets no access to your account or your repositories beyond what is public anyway, it cannot post or act for you, and nothing is posted in your name. When you click “I agree and sign”, the register checks with GitHub that this sign-in is yours, records your acceptance and removes the app’s authorization from your account.",
    whoSummary: "Signing for your employer, or under 18?",
    whoBody: 'Do not sign here. An employer signs the entity version, and a parent or guardian signs for a minor: see <a href="https://github.com/kleidos-dev/cla#who-signs">who signs</a>.',
  },
  accept: {
    title: "Accept the Kleidos Contributor Agreement",
    where: "<strong>Not signed yet:</strong> you sign with the button below.",
    signedInAs: "Signed in as",
    switch: "Switch account",
    signOut: "Sign out",
    h1: "Accept the agreement",
    summaryLabel: "What the agreement says",
    summary: [
      ["You keep", "your copyright and every right in your work."],
      ["You grant", "José M. Requena Plens a free, non-exclusive licence to publish your contribution under the project's open-source licence and to license it under other terms."],
      ["Including", "paid commercial licences. Each version with your contribution also stays available under an open-source licence (Addendum, clause 10)."],
    ],
    button: "I agree and sign",
    note: (login, pr) => `The button posts the sentence above as a comment by @${login} on ${pr}. That comment is your signature, and the public register records it.`,
    noteSignin: (login, pr) => `The button records in the public register that @${login} accepts the sentence above. That confirmation is your signature; nothing is posted on ${pr} or anywhere else.`,
    translation: null,
    error: "Tick the box to accept. Nothing was signed.",
    foldTitle: "Read the full agreement",
    foldSub: (version) => `Contributor Agreement 1.2 and the Kleidos Addendum, version ${version}`,
    binding: null,
    backbar: "Read it all? Tick the box and sign.",
    backLink: "Back to the acceptance",
    beforeTitle: "Before you accept",
    before: [
      'When you click “I agree and sign”, the sentence is posted as a comment on the pull request under your GitHub account. That comment is your signature, and the public register at <a href="https://github.com/kleidos-dev/cla">kleidos-dev/cla</a> records it.',
      'Nothing is posted until you click. If you make a mistake afterwards, write to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
      "The agreement can only be concluded in English. The Spanish texts are for information.",
      'If you are signing for your employer or another organization, or you are under 18, do not sign here: see <a href="https://github.com/kleidos-dev/cla#who-signs">who signs</a>.',
    ],
    beforeSignin: [
      'When you click “I agree and sign”, that confirmation is your signature. The public register at <a href="https://github.com/kleidos-dev/cla">kleidos-dev/cla</a> first checks with GitHub that you signed in with this account, then records your acceptance with the date and time GitHub gives and a qualified electronic time stamp.',
      'Nothing is recorded until you click, and nothing is posted in your name. If you make a mistake afterwards, or an entry names you and you did not accept, write to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
      "The agreement can only be concluded in English. The Spanish texts are for information.",
      'If you are signing for your employer or another organization, or you are under 18, do not sign here: see <a href="https://github.com/kleidos-dev/cla#who-signs">who signs</a>.',
    ],
    data: '<strong>Your data.</strong> José M. Requena Plens records your GitHub account id and login, the version you accepted, the time and a link to your acceptance comment. The record is public. No email, real name or IP address is stored. One cookie keeps you signed in for up to an hour. <a href="/privacy">Privacy notice</a>.',
    dataSignin:
      '<strong>Your data.</strong> José M. Requena Plens records your GitHub account id and login, the version you accepted, the date and time GitHub gives and the pull request you came from. The record is public; the time-stamping service receives only a hash of it. No email, real name or IP address is stored. One cookie keeps you signed in for up to an hour, and the sign-in is removed from your GitHub account as soon as your acceptance is recorded. <a href="/privacy">Privacy notice</a>.',
  },
  done: {
    titleRecording: "Signed: being recorded",
    titleRecorded: "Signed and recorded",
    whereRecording: "<strong>Signed.</strong> Being recorded in the public register, usually within a minute.",
    whereRecorded: "<strong>Signed and recorded</strong> in the public register.",
    h1: "Thank you for signing",
    lede: (pr) => `You accepted the Kleidos Contributor Agreement on ${pr}.`,
    statusRecording: "Being recorded",
    statusRecorded: "Recorded",
    account: "Account",
    accountValue: (login, id) => `@${login} (GitHub account id ${id})`,
    version: "Version",
    accepted: "Accepted (UTC)",
    comment: "Acceptance comment",
    entry: "Register entry",
    entryRecording: "Being recorded, usually within a minute.",
    checkNow: "Check now",
    back: "Back to the pull request",
    keep: 'This page is your confirmation: save or print it. The full text you accepted stays at <a href="/agreement?lang=en" hreflang="en">cla.kleidos.dev/agreement</a>.',
    checks: "The check on the pull request turns green by itself once the entry is recorded.",
  },
  status: {
    title: "Kleidos Contributor Agreement",
    signedTitle: "Already signed",
    signed: (version, date) => `You accepted version ${version} on ${date}. Nothing to do: the pull request is being checked again.`,
    entry: "Register entry",
    nothingTitle: "Nothing to sign",
    exempt: (login) => `@${login} is on the Kleidos exemption list: nothing to sign.`,
    entity: (login, entity) => `@${login} is covered by the agreement of ${entity}: nothing to sign.`,
    notAuthor: (login) => `@${login} is not listed as an author of this pull request, so there is nothing to sign here.`,
    notUserTitle: "Only a personal account can sign",
    notUser: (login) => `Only a personal account can sign. @${login} is not one.`,
    paused: 'The agreement is being updated, so signing is paused for a moment. The checks keep working. Come back later, or write to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
    edited: "Your acceptance comment on this pull request was edited or deleted, so it cannot be recorded. Nothing is kept from it. To accept, sign in again below.",
    recordFailed: "Your acceptance could not be recorded: GitHub did not confirm the sign-in, or it had expired. Nothing was recorded. To accept, sign in again below.",
  },
  agreement: {
    title: "Kleidos Contributor Agreement",
    entityTitle: "Kleidos Contributor Agreement (entity version)",
    eyebrow: (version) => `The text you sign · version ${version}`,
    h1: "Kleidos Contributor Agreement",
    entityH1: "Kleidos Contributor Agreement (entity version)",
    lede: "Every contributor accepts it once. It is made of two texts accepted together: the Contributor Agreement 1.2 and the Kleidos Addendum, which prevails where they differ.",
    how: "To sign, open a pull request in a Kleidos repository and follow the link the bot posts on it.",
    entity: 'For a company or other organization: <a href="/agreement/entity">the entity version</a>.',
    entityNote:
      'The entity version is signed outside this site: as a PDF with an electronic signature, or by email from the entity\'s domain to <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>, with the list of the GitHub account ids it authorizes. Accounts it covers sign nothing here.',
    entityOnlyEnglish: null,
    toc: "Contents",
    partA: "Contributor Agreement",
    partB: "Kleidos Addendum",
    partSummary: "Summary",
    partSummarySub: "",
    banner: null,
  },
  privacy: { title: "Privacy notice · Kleidos Contributor Agreement", eyebrow: "Privacy" },
  meta: (version, sha) => `Version ${version} · SHA-256 <code>${sha}</code>`,
  downloads: "Download",
  notConfigured: "The CLA bot is not configured yet: signing opens once its GitHub App is set up. Come back later, or write to mail@kleidos.dev.",
};

const ES: Strings = {
  skip: "Saltar al contenido",
  brandName: "Kleidos",
  brandSub: "Acuerdo de Contribución",
  langNav: "Idioma",
  steps: ["Paso 1 de 2 · Entrar", "Paso 2 de 2 · Aceptar", "Hecho · Firmado"],
  footer: [
    ["El acuerdo", "/agreement"],
    ["Aviso de privacidad", "/privacy"],
    ["Registro y código fuente", "https://github.com/kleidos-dev/cla"],
    ["mail@kleidos.dev", "mailto:mail@kleidos.dev"],
  ],
  prLabel: "Pull request",
  start: {
    title: "Firma el Acuerdo de Contribución de Kleidos",
    where: "<strong>Aún no has firmado nada.</strong> Primero entra; aceptas en la página siguiente.",
    h1: "Firma el Acuerdo de Contribución de Kleidos",
    lede: "Quien contribuye a Kleidos acepta este acuerdo una sola vez, y desde entonces cubre todos los repositorios de Kleidos. Sigues siendo el autor y el titular de lo que aportas.",
    stillLabel: "Falta firmar",
    nobody: "Nadie: han firmado todas las personas autoras",
    button: "Entra con GitHub para firmar",
    buttonAgain: "Vuelve a entrar con GitHub para firmar",
    note: "Entrar solo sirve para saber quién eres. El resumen y la firma están en la página siguiente.",
    links: [
      ["Leer el acuerdo", "/agreement"],
      ["Aviso de privacidad", "/privacy"],
    ],
    ghSummary: "Qué te enseñará GitHub",
    ghBody:
      "GitHub te pide autorizar <strong>kleidos-cla</strong>, de kleidos-dev, y enumera «Verify your GitHub identity», «Know which resources you can access» y «Act on your behalf». GitHub escribe esas líneas para toda aplicación de GitHub, y añade cuándo se creó la aplicación y cuántas personas la usan. kleidos-cla lee el número y el nombre de tu cuenta, y publica un comentario en este pull request solo cuando pulsas «Acepto y firmo». Su permiso se retira en cuanto lo ha hecho.",
    ghBodySignin:
      "GitHub te pide autorizar <strong>Kleidos CLA sign-in</strong>, de kleidos-dev: una aplicación aparte, sin ningún permiso, que solo sirve para saber qué cuenta eres. No recibe acceso a tu cuenta ni a tus repositorios más allá de lo que ya es público, no puede publicar ni actuar en tu nombre, y no se publica nada con tu cuenta. Al pulsar «Acepto y firmo», el registro comprueba con GitHub que esa sesión es tuya, anota tu aceptación y retira la autorización de la aplicación de tu cuenta.",
    whoSummary: "¿Firmas por tu empresa o eres menor de edad?",
    whoBody: 'No firmes aquí. Una empresa firma la versión para entidades, y por un menor firma su padre, madre o tutor: consulta <a href="https://github.com/kleidos-dev/cla#who-signs">quién firma</a>.',
  },
  accept: {
    title: "Acepta el Acuerdo de Contribución de Kleidos",
    where: "<strong>Aún no has firmado:</strong> firmas con el botón de abajo.",
    signedInAs: "Has entrado como",
    switch: "Cambiar de cuenta",
    signOut: "Salir",
    h1: "Acepta el acuerdo",
    summaryLabel: "Qué dice el acuerdo",
    summary: [
      ["Conservas", "tus derechos de autor y todos los derechos sobre tu obra."],
      ["Concedes", "a José M. Requena Plens una licencia gratuita y no exclusiva para publicar tu aportación con la licencia libre del proyecto y licenciarla en otras condiciones."],
      ["Incluye", "licencias comerciales de pago. Cada versión que contenga tu aportación seguirá disponible también con una licencia libre (Anexo, cláusula 10)."],
    ],
    button: "Acepto y firmo",
    note: (login, pr) => `El botón publica la frase de arriba como comentario de @${login} en ${pr}. Ese comentario es tu firma, y el registro público lo anota.`,
    noteSignin: (login, pr) => `El botón anota en el registro público que @${login} acepta la frase de arriba. Esa confirmación es tu firma; no se publica nada en ${pr} ni en ningún otro sitio.`,
    translation: {
      summary: "Qué dice esta frase (traducción informativa)",
      body: (short, version) =>
        `«He leído y acepto el Acuerdo de Contribución de Kleidos, versión ${version} (SHA-256 ${short}), formado por el texto del acuerdo y su Anexo. Entiendo que permite a José M. Requena Plens licenciar mis aportaciones también en otras condiciones, incluidas licencias comerciales de pago. Soy mayor de edad y estoy facultado para licenciar lo que aporto». Se publica en inglés, que es el texto que obliga.`,
    },
    error: "Marca la casilla para aceptar. No se ha firmado nada.",
    foldTitle: "Leer el acuerdo completo",
    foldSub: (version) => `Traducción informativa del Acuerdo y del Anexo, versión ${version}`,
    binding: 'Solo el texto inglés obliga: <a href="/agreement?lang=en" hreflang="en" lang="en">Kleidos Contributor Agreement</a>. Lo que sigue es una traducción informativa.',
    backbar: "¿Ya lo has leído? Marca la casilla y firma.",
    backLink: "Volver a la aceptación",
    beforeTitle: "Antes de aceptar",
    before: [
      'Al pulsar «Acepto y firmo», la frase se publica como comentario en el pull request con tu cuenta de GitHub. Ese comentario es tu firma, y el registro público <a href="https://github.com/kleidos-dev/cla">kleidos-dev/cla</a> lo anota.',
      'No se publica nada hasta que pulsas. Si te equivocas después, escribe a <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
      "El acuerdo solo se celebra en inglés. Los textos en español son informativos.",
      'Si firmas por tu empresa u otra organización, o eres menor de edad, no firmes aquí: consulta <a href="https://github.com/kleidos-dev/cla#who-signs">quién firma</a>.',
    ],
    beforeSignin: [
      'Al pulsar «Acepto y firmo», esa confirmación es tu firma. El registro público <a href="https://github.com/kleidos-dev/cla">kleidos-dev/cla</a> comprueba primero con GitHub que entraste con esta cuenta y después anota tu aceptación con la fecha y la hora que da GitHub y un sello de tiempo electrónico cualificado.',
      'No se anota nada hasta que pulsas, y no se publica nada en tu nombre. Si te equivocas después, o una entrada te nombra y no aceptaste, escribe a <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
      "El acuerdo solo se celebra en inglés. Los textos en español son informativos.",
      'Si firmas por tu empresa u otra organización, o eres menor de edad, no firmes aquí: consulta <a href="https://github.com/kleidos-dev/cla#who-signs">quién firma</a>.',
    ],
    data: '<strong>Tus datos.</strong> José M. Requena Plens anota el número y el nombre de tu cuenta de GitHub, la versión aceptada, la hora y el enlace a tu comentario de aceptación. El registro es público. No se guarda tu correo, tu nombre real ni tu dirección IP. Una cookie mantiene tu sesión abierta hasta una hora. <a href="/privacy">Aviso de privacidad</a>.',
    dataSignin:
      '<strong>Tus datos.</strong> José M. Requena Plens anota el número y el nombre de tu cuenta de GitHub, la versión aceptada, la fecha y la hora que da GitHub y el pull request del que vienes. El registro es público; al servicio de sellado de tiempo solo llega un resumen (hash) de la entrada. No se guarda tu correo, tu nombre real ni tu dirección IP. Una cookie mantiene tu sesión abierta hasta una hora, y la autorización se retira de tu cuenta de GitHub en cuanto se anota tu aceptación. <a href="/privacy">Aviso de privacidad</a>.',
  },
  done: {
    titleRecording: "Firmado: anotándose",
    titleRecorded: "Firmado y anotado",
    whereRecording: "<strong>Has firmado.</strong> Se está anotando en el registro público; suele tardar menos de un minuto.",
    whereRecorded: "<strong>Firmado y anotado</strong> en el registro público.",
    h1: "Gracias por firmar",
    lede: (pr) => `Has aceptado el Acuerdo de Contribución de Kleidos en ${pr}.`,
    statusRecording: "Anotándose",
    statusRecorded: "Anotado",
    account: "Cuenta",
    accountValue: (login, id) => `@${login} (cuenta de GitHub n.º ${id})`,
    version: "Versión",
    accepted: "Aceptado (UTC)",
    comment: "Comentario de aceptación",
    entry: "Entrada del registro",
    entryRecording: "Anotándose; suele tardar menos de un minuto.",
    checkNow: "Comprobar ahora",
    back: "Volver al pull request",
    keep: 'Esta página es tu confirmación: guárdala o imprímela. El texto completo que aceptaste sigue en <a href="/agreement?lang=en" hreflang="en">cla.kleidos.dev/agreement</a>.',
    checks: "La comprobación del pull request se pone en verde sola cuando la entrada queda anotada.",
  },
  status: {
    title: "Acuerdo de Contribución de Kleidos",
    signedTitle: "Ya has firmado",
    signed: (version, date) => `Aceptaste la versión ${version} el ${date}. No hay nada que hacer: se vuelve a comprobar el pull request.`,
    entry: "Entrada del registro",
    nothingTitle: "No hay nada que firmar",
    exempt: (login) => `@${login} está en la lista de exenciones de Kleidos: no hay nada que firmar.`,
    entity: (login, entity) => `@${login} está cubierto por el acuerdo de ${entity}: no hay nada que firmar.`,
    notAuthor: (login) => `@${login} no figura como autor de este pull request, así que aquí no hay nada que firmar.`,
    notUserTitle: "Solo puede firmar una cuenta personal",
    notUser: (login) => `Solo puede firmar una cuenta personal, y @${login} no lo es.`,
    paused: 'El acuerdo se está actualizando, así que la firma está en pausa un momento. Las comprobaciones siguen funcionando. Vuelve más tarde o escribe a <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>.',
    edited: "Tu comentario de aceptación en este pull request se editó o se borró, así que no se puede anotar. No se guarda nada de él. Para aceptar, vuelve a entrar abajo.",
    recordFailed: "No se pudo anotar tu aceptación: GitHub no confirmó la sesión, o había caducado. No se ha anotado nada. Para aceptar, vuelve a entrar abajo.",
  },
  agreement: {
    title: "Acuerdo de Contribución de Kleidos (traducción informativa)",
    entityTitle: "Acuerdo de Contribución de Kleidos (versión para entidades, en inglés)",
    eyebrow: (version) => `Traducción informativa · versión ${version}`,
    h1: "Acuerdo de Contribución de Kleidos",
    entityH1: "Acuerdo de Contribución de Kleidos (versión para entidades)",
    lede: "Lo acepta una vez cada persona que contribuye. Lo forman dos textos que se aceptan juntos: el Contributor Agreement 1.2 y el Anexo de Kleidos, que prevalece si difieren.",
    how: "Para firmar, abre un pull request en un repositorio de Kleidos y sigue el enlace que publica el bot.",
    entity: 'Para una empresa u otra organización: <a href="/agreement/entity" hreflang="en">la versión para entidades</a> (en inglés).',
    entityNote:
      'La versión para entidades se firma fuera de este sitio: en PDF con firma electrónica, o por correo desde el dominio de la entidad a <a href="mailto:mail@kleidos.dev">mail@kleidos.dev</a>, con la lista de números de cuenta de GitHub que autoriza. Las cuentas que cubre no firman nada aquí.',
    entityOnlyEnglish: "La versión para entidades solo está en inglés, que es el texto que obliga. Su Anexo es el mismo que el de la versión individual, y tiene traducción informativa en la página del acuerdo.",
    toc: "Contenido",
    partA: "Acuerdo de Contribución (traducción informativa)",
    partB: "Anexo de Kleidos (traducción informativa)",
    partSummary: "Resumen",
    partSummarySub: "Qué conservas, qué concedes, para qué",
    banner:
      '<p><strong>Solo el texto inglés obliga.</strong> El acuerdo se celebra en inglés; esta página es una traducción informativa y, si dice algo distinto, prevalece el inglés. <a href="/agreement?lang=en" hreflang="en" lang="en">Kleidos Contributor Agreement (English)</a></p><p lang="en"><strong>Only the English text is binding.</strong> This page is an informative Spanish translation.</p>',
  },
  privacy: { title: "Aviso de privacidad · Acuerdo de Contribución de Kleidos", eyebrow: "Privacidad" },
  meta: (version, sha) => `Versión ${version} · SHA-256 <code>${sha}</code>`,
  downloads: "Descargar (en inglés)",
  notConfigured: "El bot del CLA aún no está configurado: la firma se abrirá cuando su aplicación de GitHub esté instalada. Vuelve más tarde o escribe a mail@kleidos.dev.",
};

export const S: Record<Lang, Strings> = { en: EN, es: ES };

/** The one-message pages: a title, one plain-text sentence, and where a back link goes. */
export const MESSAGES = {
  notServed: { en: ["Not served", "This repository is not served by the Kleidos CLA bot."], es: ["Repositorio no atendido", "El bot del CLA de Kleidos no atiende este repositorio."] },
  headMoved: {
    en: ["The pull request changed", "The pull request received new commits while it was being read. Nothing was posted. Reload this page."],
    es: ["El pull request ha cambiado", "El pull request recibió commits nuevos mientras se leía. No se ha publicado nada. Vuelve a cargar esta página."],
  },
  ghRateLimited: { en: ["GitHub is rate limiting", "GitHub asked us to slow down. Wait a minute and reload this page."], es: ["GitHub está limitando las peticiones", "GitHub nos ha pedido que vayamos más despacio. Espera un minuto y vuelve a cargar esta página."] },
  ghNotFound: { en: ["Not found", "GitHub does not know this pull request."], es: ["No encontrado", "GitHub no conoce este pull request."] },
  ghUnavailable: {
    en: ["GitHub unavailable", "GitHub did not answer as expected. Nothing was posted. Wait a minute and reload this page."],
    es: ["GitHub no responde", "GitHub no ha respondido como se esperaba. No se ha publicado nada. Espera un minuto y vuelve a cargar esta página."],
  },
  tooManySign: { en: ["Too many requests", "Too many requests from your network. Wait a minute and reload this page."], es: ["Demasiadas peticiones", "Hay demasiadas peticiones desde tu red. Espera un minuto y vuelve a cargar esta página."] },
  tooManyAuth: { en: ["Too many requests", "Too many sign-in attempts from your network. Wait a minute and try again."], es: ["Demasiadas peticiones", "Hay demasiados intentos de entrar desde tu red. Espera un minuto y vuelve a intentarlo."] },
  tooManyAgree: { en: ["Too many requests", "Too many attempts. Wait a minute and try again. Nothing was posted."], es: ["Demasiadas peticiones", "Demasiados intentos. Espera un minuto y vuelve a intentarlo. No se ha publicado nada."] },
  noTarget: { en: ["Not found", "There is no pull request to sign for at this address."], es: ["No encontrado", "En esta dirección no hay ningún pull request que firmar."] },
  closed: {
    en: ["Pull request closed", "This pull request is closed, so there is nothing to sign on it. Open or reopen a pull request and follow its link."],
    es: ["Pull request cerrado", "Este pull request está cerrado, así que no hay nada que firmar en él. Abre o reabre un pull request y sigue su enlace."],
  },
  locked: { en: ["Pull request locked", "This pull request is locked, so no acceptance can be posted on it. Write to mail@kleidos.dev."], es: ["Pull request bloqueado", "Este pull request está bloqueado, así que no se puede publicar ninguna aceptación en él. Escribe a mail@kleidos.dev."] },
  badLink: {
    en: ["Bad link", "This sign-in link is not valid. Go back to the pull request and follow its link again."],
    es: ["Enlace no válido", "Este enlace para entrar no es válido. Vuelve al pull request y sigue su enlace otra vez."],
  },
  oauthExpired: {
    en: ["Session expired", "The sign-in took too long or was already used. Go back to the pull request and follow its link again."],
    es: ["Sesión caducada", "La entrada tardó demasiado o ya se usó. Vuelve al pull request y sigue su enlace otra vez."],
  },
  oauthState: { en: ["Sign-in refused", "This sign-in did not start here. Nothing was signed. Follow the pull request's link again."], es: ["Entrada rechazada", "Esta entrada no empezó aquí. No se ha firmado nada. Sigue otra vez el enlace del pull request."] },
  oauthCancelled: { en: ["Authorization cancelled", "GitHub's authorization was cancelled, so nothing was signed or posted."], es: ["Autorización cancelada", "Se canceló la autorización de GitHub, así que no se ha firmado ni publicado nada."] },
  oauthCode: { en: ["Sign-in refused", "GitHub's answer was not valid. Follow the pull request's link again."], es: ["Entrada rechazada", "La respuesta de GitHub no era válida. Sigue otra vez el enlace del pull request."] },
  oauthExchange: {
    en: ["Sign-in refused", "GitHub did not accept this sign-in (it may have been used already). Follow the pull request's link again."],
    es: ["Entrada rechazada", "GitHub no ha aceptado esta entrada (puede que ya se hubiera usado). Sigue otra vez el enlace del pull request."],
  },
  oauthUser: { en: ["Sign-in refused", "GitHub's answer was not valid."], es: ["Entrada rechazada", "La respuesta de GitHub no era válida."] },
  refusedOrigin: { en: ["Refused", "This form did not come from cla.kleidos.dev, so nothing was posted."], es: ["Rechazado", "Este formulario no venía de cla.kleidos.dev, así que no se ha publicado nada."] },
  refusedStale: { en: ["Refused", "This form is out of date. Reload the page and try again."], es: ["Rechazado", "Este formulario está desfasado. Vuelve a cargar la página e inténtalo otra vez."] },
  formUnreadable: { en: ["Refused", "The form could not be read, so nothing was posted. Reload the page and try again."], es: ["Rechazado", "No se pudo leer el formulario, así que no se ha publicado nada. Vuelve a cargar la página e inténtalo otra vez."] },
  sessionExpired: {
    en: ["Session expired", "Your sign-in has expired, so nothing was posted. Go back to the pull request and follow its link again."],
    es: ["Sesión caducada", "Tu sesión ha caducado, así que no se ha publicado nada. Vuelve al pull request y sigue su enlace otra vez."],
  },
  formInvalid: { en: ["Refused", "The form is not valid, so nothing was posted."], es: ["Rechazado", "El formulario no es válido, así que no se ha publicado nada."] },
  csrf: {
    en: ["Refused", "This form is out of date or was not made for you, so nothing was posted. Reload the sign page and try again."],
    es: ["Rechazado", "Este formulario está desfasado o no se hizo para ti, así que no se ha publicado nada. Vuelve a cargar la página de firma e inténtalo otra vez."],
  },
  signInAgain: { en: ["Sign in again", "Sign in again on this pull request's page to accept. Nothing was posted."], es: ["Vuelve a entrar", "Vuelve a entrar en la página de este pull request para aceptar. No se ha publicado nada."] },
  signInAgainGitHub: {
    en: ["Sign in again", "GitHub did not accept the comment with your sign-in (it may have expired or been revoked). Nothing was posted."],
    es: ["Vuelve a entrar", "GitHub no aceptó el comentario con tu sesión (puede que caducara o se revocara). No se ha publicado nada."],
  },
  paused: { en: ["Signing paused", "The agreement is being updated, so signing is paused. Nothing was posted. Try again later."], es: ["Firma en pausa", "El acuerdo se está actualizando, así que la firma está en pausa. No se ha publicado nada. Inténtalo más tarde."] },
  changed: { en: ["The agreement changed", "The text on your page is not the current one, so nothing was posted. Reload the sign page."], es: ["El acuerdo ha cambiado", "El texto de tu página no es el actual, así que no se ha publicado nada. Vuelve a cargar la página de firma."] },
  postedClosed: { en: ["Nothing posted", "This pull request is closed, so nothing was posted."], es: ["No se ha publicado nada", "Este pull request está cerrado, así que no se ha publicado nada."] },
  postedLocked: { en: ["Nothing posted", "This pull request is locked, so nothing was posted."], es: ["No se ha publicado nada", "Este pull request está bloqueado, así que no se ha publicado nada."] },
  postedPrivate: { en: ["Nothing posted", "There is no pull request to sign for at this address."], es: ["No se ha publicado nada", "En esta dirección no hay ningún pull request que firmar."] },
  postedNotUser: { en: ["Nothing posted", "Only a personal account can sign. Nothing was posted."], es: ["No se ha publicado nada", "Solo puede firmar una cuenta personal. No se ha publicado nada."] },
  postedSigned: { en: ["Nothing posted", "You have already accepted this agreement. Nothing was posted."], es: ["No se ha publicado nada", "Ya has aceptado este acuerdo. No se ha publicado nada."] },
  postedNotNeeded: { en: ["Nothing posted", "This account does not need to sign on this pull request, so nothing was posted."], es: ["No se ha publicado nada", "Esta cuenta no tiene que firmar en este pull request, así que no se ha publicado nada."] },
  notConfigured: { en: ["Not configured yet", EN.notConfigured], es: ["Aún no configurado", ES.notConfigured] },
  recorderUnreachable: {
    en: ["Not recorded", "The register could not be asked to record your acceptance, so nothing was recorded. Sign in again in a minute."],
    es: ["No anotado", "No se pudo pedir al registro que anotara tu aceptación, así que no se ha anotado nada. Vuelve a entrar dentro de un minuto."],
  },
} satisfies Record<string, Record<Lang, Pair>>;

export type MessageKey = keyof typeof MESSAGES;

export const BACK = {
  sign: { en: "Back to the sign page", es: "Volver a la página de firma" },
  pr: { en: "Back to the pull request", es: "Volver al pull request" },
} satisfies Record<string, Record<Lang, string>>;
