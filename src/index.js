const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  errors
} = require('cozy-konnector-libs')

process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://6806774c8e994c328e511a7925a2dfda:2663acb6d8b1458db67dda05eb9bd401@sentry.cozycloud.cc/53'

const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'https://www.helloasso.com'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  const userPage = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = await request(`${baseUrl}${userPage}/paiements`)
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['helloasso']
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  const url = `${baseUrl}/utilisateur/authentificate`
  let $ = null
  try {
    await request({
      method: 'POST',
      url,
      body: JSON.stringify({
        currentUrl: `${baseUrl}/utilisateurs`,
        email: username,
        password: password,
        noRedirect: false,
        showSp: true
      }),
      headers: {
        'Content-Type': 'application/json;charset=UTF-8'
      }
    })
    $ = await request({
      url: `${baseUrl}`
    })
  } catch (e) {
    log('error', e.message)
    if (e && e.statusCode === 401) throw new Error(errors.LOGIN_FAILED)
    throw new Error(errors.VENDOR_DOWN)
  }
  const hasDisconnect = !!$('.profile-nav a[data-action=disconnect]').length
  if (!hasDisconnect) throw new Error(errors.LOGIN_FAILED)
  const userPage = $('.profile-nav a:not([data-action=disconnect])').attr(
    'href'
  )
  return userPage
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/cozy/cozy-konnector-libs/blob/master/docs/api.md#savebills)
async function parseDocuments($) {
  let variableText = ''
  $('script').each(function(i, el) {
    if (
      $(el)
        .toString()
        .match(/var dashboardParams = (.*)/)
    ) {
      variableText = $(el).toString()
    }
  })
  const clId = variableText.match(/collecteurID: (.*)\n/)[1].replace(/,/g, '')
  const clType = variableText
    .match(/collecteurType: (.*)\n/)[1]
    .replace(/'/g, '')
    .toLowerCase()
  const jsonRequest = requestFactory({ json: true, jar: true })
  const data = await jsonRequest(
    `https://www.helloasso.com/admin/handler/reports.ashx?type=Details&id_${clType}=${clId}`
  )
  return data.rows
    .filter(d => d.c[7].v === 'Validé')
    .map(data => {
      const doc = data.c
      // console.log(doc)
      const dateElements = doc[5].v.match(
        /^Date\(([0-9]*), ([0-9]*), ([0-9]*), ([0-9]*), ([0-9]*), ([0-9]*).*/
      )
      return {
        association: doc[1].v,
        campaign: doc[2].v,
        payment_type: doc[3].v,
        description: doc[4].v,
        amount: doc[6].v,
        date: getDate(dateElements),
        currency: '€',
        vendor: 'helloasso',
        fileurl: doc[9].v.match(/href="([^\s]*)"/)[1],
        filename: getFileName(doc, dateElements),
        metadata: {
          // it can be interesting that we add the date of import. This is not mandatory but may be
          // usefull for debugging or data migration
          importDate: new Date(),
          // document version, usefull for migration after change of document structure
          version: 1
        }
      }
    })
}

// string from helloasso to date
function getDate(dateElements) {
  return new Date(
    dateElements[1],
    dateElements[2],
    dateElements[3],
    dateElements[4],
    dateElements[5],
    dateElements[6]
  )
}

// date to string with '_'
function getStringDate(dateElements) {
  return `${('0' + dateElements[2]).slice(-2)}_${('0' + dateElements[3]).slice(
    -2
  )}_${dateElements[1]}`
}

// compute file name
function getFileName(doc, dateElements) {
  // account name -> doc[18].v
  // date -> doc[7].v
  // association -> doc[1].v
  // campaign -> doc[2].v
  // number -> doc[0].v
  // date_association_number_helloasso.pdf
  const association = doc[1].v.replace(/[^a-zA-Z0-9]/g, '_')
  return `${getStringDate(dateElements)}_${association}_${
    doc[0].v
  }_helloasso.pdf`
}
