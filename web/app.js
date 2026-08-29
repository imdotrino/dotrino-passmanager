// Bilingüe es/en (CONVENCIONES §9). El toggle lo trae <dotrino-topbar>; aquí solo se
// traduce lo propio de la página cuando avisa por `dotrino-lang`.
(function () {
  var STRINGS = {
    en: {
      heroTitle: 'Your passwords, kept by you',
      heroLead: 'Your own vault keeps them, on your device. When you open a site, the browser gets that site’s password and nothing else.',
      state: 'In development. Not in the Chrome store yet.',
      get: 'Download the extension',
      howto: 'How to install it',
      c1t: 'One at a time',
      c1d: 'Password managers usually keep a copy of all your passwords in the browser. This one asks for the password of the site you are opening, uses it and lets it go. And none of them leaves without you authorizing it.',
      c2t: 'Nothing is filled for you',
      c2d: 'It marks the fields where it can help and waits. Filling is always your call, and the button only shows up when there is really something to do there.',
      c3t: 'Not just passwords',
      c3d: 'Your email, your phone, your address, a site’s membership number. What you type over and over, saved once.',
      c4t: 'Nothing reaches our servers',
      c4d: 'Not your passwords, and not the sites where you use them. What travels between your devices goes sealed with a key only they hold: it cannot be read on the way.',
      c5t: 'It starts on its own',
      c5d: 'No account, no master password, nothing installed on your computer. And when you want them in one place for every browser you use, you connect a vault from the extension itself.',
      c6t: 'Bring yours, and take it away',
      c6d: 'Import what you already keep in 1Password, Bitwarden or Chrome. And export whenever you want: it is your information, and taking it with you is your call too.',
      installTitle: 'How it works',
      i0: 'The steps to install it, the button on each field, how saving works and how filling works are all in the wiki.',
      docs: 'Read the guide',
      repo: 'See the project',
      openVault: 'Open a vault',
      title: 'Dotrino — password manager',
    },
  }

  var ES = {}
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    ES[el.dataset.i18n] = el.innerHTML
  })
  ES.title = document.title

  function apply (lang) {
    var dict = lang === 'en' ? STRINGS.en : ES
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = dict[el.dataset.i18n]
      if (v) el.innerHTML = v
    })
    document.title = dict.title || ES.title
    document.documentElement.lang = lang
    var og = document.querySelector('meta[property="og:locale"]')
    if (og) og.content = lang === 'en' ? 'en_US' : 'es_ES'
  }

  document.addEventListener('dotrino-lang', function (e) {
    apply(e.detail && e.detail.lang === 'en' ? 'en' : 'es')
  })

  // Primera carga: el topbar ya decidió el idioma, pero puede tardar en montar.
  var saved = null
  try { saved = localStorage.getItem('dotrino-lang') } catch (e) {}
  var lang = saved || ((navigator.language || 'es').toLowerCase().indexOf('en') === 0 ? 'en' : 'es')
  if (lang === 'en') apply('en')
})()
