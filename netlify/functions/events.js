const https = require('https');

function fetchWithTimeout(url, headers = {}, timeoutMs = 3500) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { 'User-Agent': 'CulturalEventAggregator/1.0', ...headers }
      };

      const req = https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { 
            const parsed = JSON.parse(data);
            resolve(parsed); 
          } catch (e) { 
            resolve(null); 
          }
        });
      });

      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "À venir";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "À venir";
  const months = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

exports.handler = async function(event) {
  const city = event.queryStringParameters && event.queryStringParameters.city 
    ? event.queryStringParameters.city 
    : 'Paris';
  
  const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || '';
  const OPENAGENDA_API_KEY = process.env.OPENAGENDA_API_KEY || '';

  const parisUrl = `https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/records?where=${encodeURIComponent(`address_city = "${city}"`)}&limit=30`;
  const openAgendaUrl = `https://api.openagenda.com/v2/events?search=${encodeURIComponent(city)}${OPENAGENDA_API_KEY ? `&key=${OPENAGENDA_API_KEY}` : ''}&limit=30`;
  const ticketmasterUrl = `https://app.ticketmaster.com/discovery/v2/events.json?city=${encodeURIComponent(city)}&countryCode=FR&size=30&apikey=${TICKETMASTER_API_KEY}`;

  const promises = [
    fetchWithTimeout(parisUrl),
    OPENAGENDA_API_KEY ? fetchWithTimeout(openAgendaUrl) : Promise.resolve(null)
  ];

  if (TICKETMASTER_API_KEY) {
    promises.push(fetchWithTimeout(ticketmasterUrl));
  }

  const results = await Promise.all(promises);
  const parisRes = results[0];
  const openAgendaRes = results[1];
  const tmRes = TICKETMASTER_API_KEY ? results[2] : null;

  let rawEvents = [];

  // Mairie de Paris
  if (parisRes && parisRes.results) {
    parisRes.results.forEach(item => {
      const cat = (item.category || "").toLowerCase();
      if (!cat.includes('cinéma') && !cat.includes('film')) {
        rawEvents.push({
          id: `paris-${item.id}`,
          titre: item.title ? item.title.trim() : "Événement culturel",
          medium: item.category || "Expositions",
          lieu: item.address_name || item.address_city || city,
          jour: formatDate(item.date_start),
          prix: item.price_type === 'gratuit' ? 0 : 12,
          eventUrl: item.url || item.access_link || `https://quefaire.paris.fr/${item.id}`,
          source: "Mairie de Paris"
        });
      }
    });
  }

  // OpenAgenda
  const oaList = openAgendaRes?.events || openAgendaRes?.items || [];
  oaList.forEach(item => {
    rawEvents.push({
      id: `oa-${item.uid || item.id}`,
      titre: item.title?.fr || item.title || "Événement",
      medium: item.keywords?.fr?.[0] || "Animation",
      lieu: item.location?.name || item.location?.city || city,
      jour: formatDate(item.lastTiming?.begin || item.startDate),
      prix: item.conditions?.fr?.toLowerCase().includes('gratuit') ? 0 : 10,
      eventUrl: item.canonicalUrl || `https://openagenda.com/events/${item.slug}`,
      source: "OpenAgenda"
    });
  });

  // Ticketmaster
  if (tmRes && tmRes._embedded && tmRes._embedded.events) {
    tmRes._embedded.events.forEach(item => {
      rawEvents.push({
        id: `tm-${item.id}`,
        titre: item.name,
        medium: item.classifications?.[0]?.segment?.name || "Spectacle",
        lieu: item._embedded?.venues?.[0]?.name || city,
        jour: formatDate(item.dates?.start?.localDate),
        prix: item.priceRanges?.[0]?.min || 20,
        eventUrl: item.url,
        source: "Ticketmaster"
      });
    });
  }

  // Dédoublonnage
  const seenTitles = new Set();
  const cleanEvents = rawEvents.filter(ev => {
    const key = ev.titre.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    body: JSON.stringify(cleanEvents)
  };
};