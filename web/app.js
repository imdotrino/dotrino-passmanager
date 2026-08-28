// Bilingüe es/en (CONVENCIONES §9). El toggle lo trae <dotrino-topbar>; aquí solo se
// traduce lo propio de la página cuando avisa por `dotrino-lang`.
(function () {
  var STRINGS = {
    en: {
      heroTitle: 'Your passwords, kept by you',
      heroLead: 'Your own vault keeps them, on your device. When you open a site, the browser gets that site’s password and nothing else.',
      state: 'In development. Not in the Chrome store yet — below is how to try it.',
      c1t: 'One at a time',
      c1d: 'Password managers usually keep a copy of all your passwords in the browser. This one asks for the password of the site you are opening, uses it and lets it go.',
      c2t: 'Nothing reaches our servers',
      c2d: 'Not your passwords, and not the sites where you use them. What travels between your devices goes sealed with a key only they hold: it cannot be read on the way.',
      c3t: 'Bring what you already have',
      c3d: 'Import your passwords from 1Password, Bitwarden or Chrome. Two-step codes come along.',
      c4t: 'Leave whenever you want',
      c4d: 'Your passwords export in the format you choose. It is your information, and taking it with you is your call too.',
      installTitle: 'Try it now',
      i0: 'It is not in the Chrome store yet, so it installs by hand. Three steps, once.',
      i1: '<a href="./app/dotrino-passmanager-0.5.0.zip" download>Download the extension</a> and unzip the folder.',
      i2: 'In Chrome, open the extensions page and turn on developer mode.',
      i3: 'Click “Load unpacked” and pick the folder you just unzipped.',
      i4: 'That is it. From then on it keeps your passwords encrypted in your browser, with nothing else to set up. If you would rather have them in one place for every browser you use, you can connect a vault from the extension itself.',
      repo: 'See the project',
      openVault: 'Open a vault',
      docs: 'How to use it',
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
