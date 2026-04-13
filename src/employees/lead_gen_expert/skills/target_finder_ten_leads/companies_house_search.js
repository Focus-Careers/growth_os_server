import { searchCompanies, getCompanyOfficers } from '../../../../config/companies_house.js';
import { mapItpToSicCodes } from './sic_code_mapper.js';

// Domain resolution is intentionally NOT done here.
// It happens post-scoring in target_finder_100_leads/index.js so Serper credits are
// only spent on companies that actually passed the scoring threshold.

const CH_CANDIDATES_TARGET = 300;
const CH_PAGE_SIZE = 100;

/**
 * Parse a CH officer name into first/last name.
 * CH stores names as "SURNAME, Firstname Middlename".
 */
function parseOfficerName(name) {
  if (!name) return { first_name: null, last_name: null };
  if (name.includes(',')) {
    const [surname, rest] = name.split(',').map(s => s.trim());
    const firstName = rest?.split(' ')[0] ?? null;
    return {
      first_name: firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase() : null,
      last_name: surname.charAt(0).toUpperCase() + surname.slice(1).toLowerCase(),
    };
  }
  const parts = name.split(' ');
  return { first_name: parts[0] ?? null, last_name: parts.slice(1).join(' ') || null };
}

/**
 * Extract a usable location string from a CH registered address.
 */
function extractLocation(address) {
  if (!address) return null;
  const parts = [address.locality, address.region, address.postal_code].filter(Boolean);
  return parts.join(', ') || null;
}

const SIC_DESCRIPTIONS = {
  // Food, drink, tobacco
  '10110': 'Processing and preserving of meat',
  '10200': 'Processing and preserving of fish',
  '10510': 'Dairy products',
  '10710': 'Bread, fresh pastry goods and cakes',
  '10810': 'Sugar manufacture',
  '10890': 'Other food products',
  '11010': 'Distilling and blending of spirits',
  '11050': 'Brewing of beer',
  // Textiles and leather
  '13100': 'Preparation and spinning of textile fibres',
  '13200': 'Weaving of textiles',
  '13300': 'Finishing of textiles',
  '13910': 'Knitted and crocheted fabrics',
  '14110': 'Leather clothes',
  '14190': 'Other wearing apparel',
  '15110': 'Tanning and dressing of leather',
  '15120': 'Luggage, handbags, saddlery and harness',
  // Wood, paper, printing
  '16100': 'Sawmilling and planing of wood',
  '16210': 'Veneer sheets and wood-based panels',
  '16230': 'Builders carpentry and joinery',
  '17110': 'Manufacture of pulp',
  '17120': 'Manufacture of paper and paperboard',
  '17210': 'Corrugated paper and paperboard, sacks and bags',
  '17220': 'Household and sanitary goods of paper',
  '17290': 'Other articles of paper and paperboard',
  '18110': 'Printing of newspapers',
  '18121': 'Manufacture of printed labels',
  '18129': 'Other printing',
  // Chemicals and pharmaceuticals
  '20110': 'Industrial gases',
  '20120': 'Dyes and pigments',
  '20130': 'Other inorganic basic chemicals',
  '20140': 'Other organic basic chemicals',
  '20150': 'Fertilisers and nitrogen compounds',
  '20160': 'Plastics in primary forms',
  '20170': 'Synthetic rubber in primary forms',
  '20200': 'Pesticides and agro-chemical products',
  '20300': 'Paints, varnishes and similar coatings',
  '20410': 'Soap and detergents',
  '20420': 'Perfumes and toilet preparations',
  '20510': 'Explosives',
  '20590': 'Other chemical products',
  '21100': 'Pharmaceutical preparations',
  '21200': 'Pharmaceutical preparations',
  // Rubber and plastics
  '22110': 'Manufacture of rubber tyres and tubes',
  '22190': 'Manufacture of other rubber products',
  '22210': 'Manufacture of plastic plates, sheets, tubes and profiles',
  '22220': 'Manufacture of plastic packing goods',
  '22230': "Manufacture of builders' ware of plastic",
  '22290': 'Manufacture of other plastic products',
  // Non-metallic minerals
  '23110': 'Manufacture of flat glass',
  '23200': 'Manufacture of refractory products',
  '23310': 'Manufacture of ceramic tiles and flags',
  '23410': 'Manufacture of ceramic household and ornamental articles',
  '23610': 'Manufacture of concrete products for construction purposes',
  '23700': 'Cutting, shaping and finishing of stone',
  '23900': 'Manufacture of abrasive products and other non-metallic mineral products',
  // Basic metals
  '24100': 'Manufacture of basic iron and steel and of ferro-alloys',
  '24200': 'Manufacture of tubes, pipes, hollow profiles and related fittings of steel',
  '24310': 'Cold drawing of bars',
  '24340': 'Cold drawing of wire',
  '24410': 'Precious metals production',
  '24420': 'Aluminium production',
  '24430': 'Lead, zinc and tin production',
  '24440': 'Copper production',
  '24510': 'Casting of iron',
  '24520': 'Casting of steel',
  '24530': 'Casting of light metals',
  // Fabricated metal products
  '25110': 'Manufacture of metal structures and parts of structures',
  '25120': 'Manufacture of metal doors and windows',
  '25210': 'Manufacture of central heating radiators and boilers',
  '25290': 'Manufacture of other metal tanks, reservoirs and containers',
  '25300': 'Manufacture of steam generators',
  '25500': 'Forging, pressing, stamping and roll-forming of metal',
  '25610': 'Treatment and coating of metals',
  '25620': 'Machining',
  '25710': 'Manufacture of cutlery',
  '25720': 'Manufacture of locks and hinges',
  '25730': 'Manufacture of tools',
  '25910': 'Manufacture of steel drums and similar containers',
  '25920': 'Manufacture of light metal packaging',
  '25930': 'Manufacture of wire products, chain and springs',
  '25940': 'Manufacture of fasteners and screw machine products',
  '25990': 'Manufacture of other fabricated metal products',
  // Electronics
  '26110': 'Manufacture of electronic components',
  '26120': 'Manufacture of loaded electronic boards',
  '26200': 'Manufacture of computers and peripheral equipment',
  '26301': 'Manufacture of telephone handsets',
  '26309': 'Manufacture of other communication equipment',
  '26400': 'Manufacture of consumer electronics',
  '26511': 'Manufacture of electronic measuring instruments',
  '26512': 'Manufacture of non-electronic measuring instruments',
  '26513': 'Manufacture of industrial process control equipment',
  '26520': 'Manufacture of watches and clocks',
  '26600': 'Manufacture of irradiation and electromedical equipment',
  '26700': 'Manufacture of optical instruments and photographic equipment',
  '26800': 'Manufacture of magnetic and optical media',
  // Electrical equipment
  '27110': 'Manufacture of electric motors, generators and transformers',
  '27120': 'Manufacture of electricity distribution and control apparatus',
  '27200': 'Manufacture of batteries and accumulators',
  '27310': 'Manufacture of fibre optic cables',
  '27320': 'Manufacture of other electronic and electric wires and cables',
  '27330': 'Manufacture of wiring devices',
  '27400': 'Manufacture of electric lighting equipment',
  '27510': 'Manufacture of electric domestic appliances',
  '27520': 'Manufacture of non-electric domestic appliances',
  '27900': 'Manufacture of other electrical equipment',
  // Machinery and equipment
  '28110': 'Manufacture of engines and turbines',
  '28120': 'Manufacture of fluid power equipment',
  '28130': 'Manufacture of other pumps and compressors',
  '28140': 'Manufacture of other taps and valves',
  '28150': 'Manufacture of bearings, gears, gearing and driving elements',
  '28210': 'Manufacture of ovens, furnaces and furnace burners',
  '28220': 'Manufacture of lifting and handling equipment',
  '28230': 'Manufacture of office machinery and equipment',
  '28240': 'Manufacture of power-driven hand tools',
  '28250': 'Manufacture of non-domestic cooling and ventilation equipment',
  '28290': 'Manufacture of other general-purpose machinery',
  '28300': 'Manufacture of agricultural and forestry machinery',
  '28410': 'Manufacture of metal forming machinery',
  '28490': 'Manufacture of other machine tools',
  '28910': 'Manufacture of machinery for metallurgy',
  '28920': 'Manufacture of machinery for mining, quarrying and construction',
  '28930': 'Manufacture of machinery for food, beverage and tobacco processing',
  '28940': 'Manufacture of machinery for textile, apparel and leather production',
  '28950': 'Manufacture of machinery for paper and paperboard production',
  '28960': 'Manufacture of plastics and rubber machinery',
  '28990': 'Manufacture of other special-purpose machinery',
  // Motor vehicles
  '29100': 'Manufacture of motor vehicles',
  '29200': 'Manufacture of bodies for motor vehicles',
  '29310': 'Manufacture of electrical and electronic equipment for motor vehicles',
  '29320': 'Manufacture of other parts and accessories for motor vehicles',
  // Other transport
  '30110': 'Building of ships and floating structures',
  '30120': 'Building of pleasure and sporting boats',
  '30200': 'Manufacture of railway locomotives and rolling stock',
  '30300': 'Manufacture of air and spacecraft and related machinery',
  '30910': 'Manufacture of motorcycles',
  '30920': 'Manufacture of bicycles and invalid carriages',
  '30990': 'Manufacture of other transport equipment',
  // Furniture and other manufacturing
  '31010': 'Manufacture of office and shop furniture',
  '31020': 'Manufacture of kitchen furniture',
  '31090': 'Manufacture of other furniture',
  '32110': 'Striking of coins',
  '32120': 'Manufacture of jewellery and related articles',
  '32300': 'Manufacture of sports goods',
  '32400': 'Manufacture of games and toys',
  '32500': 'Manufacture of medical and dental instruments and supplies',
  '32990': 'Other manufacturing n.e.c.',
  // Repair and installation of machinery
  '33110': 'Repair of fabricated metal products',
  '33120': 'Repair of machinery',
  '33130': 'Repair of electronic and optical equipment',
  '33140': 'Repair of electrical equipment',
  '33150': 'Repair and maintenance of ships and boats',
  '33190': 'Repair of other equipment',
  '33200': 'Installation of industrial machinery and equipment',
  // Construction
  '41100': 'Development of building projects',
  '41201': 'Construction of commercial buildings',
  '41202': 'Construction of domestic buildings',
  '42110': 'Construction of roads and motorways',
  '42210': 'Construction of utility projects for fluids',
  '42990': 'Construction of other civil engineering projects',
  '43110': 'Demolition',
  '43120': 'Site preparation',
  '43210': 'Electrical installation',
  '43220': 'Plumbing, heat and air-conditioning installation',
  '43290': 'Other construction installation',
  '43310': 'Plastering',
  '43320': 'Joinery installation',
  '43330': 'Floor and wall covering',
  '43341': 'Painting',
  '43342': 'Glazing',
  '43390': 'Other building completion and finishing',
  '43910': 'Roofing activities',
  '43991': 'Scaffold erection',
  '43999': 'Other specialised construction activities n.e.c.',
  // Wholesale trade (industrial/manufacturing)
  '46610': 'Wholesale of agricultural machinery, equipment and supplies',
  '46620': 'Wholesale of machine tools',
  '46630': 'Wholesale of mining, construction and civil engineering machinery',
  '46640': 'Wholesale of machinery for the textile industry',
  '46660': 'Wholesale of other office machinery and equipment',
  '46690': 'Wholesale of other machinery and equipment',
  '46720': 'Wholesale of metals and metal ores',
  '46730': 'Wholesale of wood, construction materials and sanitary equipment',
  '46740': 'Wholesale of hardware, plumbing and heating equipment and supplies',
  '46750': 'Wholesale of chemical products',
  '46760': 'Wholesale of other intermediate products',
  '46770': 'Wholesale of waste and scrap',
};

function describeSicCode(code) {
  return SIC_DESCRIPTIONS[code] ?? `SIC ${code}`;
}

/**
 * Search Companies House for companies matching an ITP.
 * Paginates up to CH_CANDIDATES_TARGET results.
 * Domain resolution is NOT done here — it happens post-scoring.
 *
 * @param {{ itp, existingDomains: Set, existingCHNumbers: Set, customerDomains: Set, onProgress? }} opts
 * @returns {Promise<Array>}
 */
export async function searchCompaniesHouseForItp({ itp, existingDomains, existingCHNumbers, customerDomains, onProgress }) {
  const sicCodes = await mapItpToSicCodes(itp);
  if (sicCodes.length === 0) {
    console.log('[ch_search] No SIC codes mapped, skipping Companies House search');
    return [];
  }

  console.log(`[ch_search] Searching CH with SIC codes: ${sicCodes.join(', ')} | location: ${itp.location ?? 'UK'}`);

  const locationParam = (itp.location && itp.location.toLowerCase() !== 'anywhere in the uk')
    ? itp.location
    : undefined;

  // Paginate up to CH_CANDIDATES_TARGET companies
  const allItems = [];
  for (let page = 0; allItems.length < CH_CANDIDATES_TARGET; page++) {
    const searchResult = await searchCompanies({
      sicCodes,
      location: locationParam,
      startIndex: page * CH_PAGE_SIZE,
      size: CH_PAGE_SIZE,
    });
    const items = searchResult.items ?? [];
    allItems.push(...items);
    if (items.length < CH_PAGE_SIZE) break; // No more pages available
  }

  console.log(`[ch_search] Fetched ${allItems.length} CH candidates across ${Math.ceil(allItems.length / CH_PAGE_SIZE)} page(s)`);

  const results = [];
  let processed = 0;

  for (const item of allItems) {
    processed++;
    if (onProgress) onProgress(processed, allItems.length);

    const companyNumber = item.company_number;
    if (!companyNumber) continue;

    if (existingCHNumbers.has(companyNumber)) {
      console.log(`[ch_search] Skipping ${companyNumber} (already exists)`);
      continue;
    }

    // Use search result data directly — no separate profile fetch needed.
    // The CH advanced search response includes sic_codes, date_of_creation,
    // registered_office_address and company_type.
    const companyName = item.company_name ?? '';
    const location = extractLocation(item.registered_office_address);
    const companySicCodes = item.sic_codes ?? [];

    // Fetch officers — needed for scoring context (director names/roles)
    const officers = await getCompanyOfficers(companyNumber);
    const parsedOfficers = officers.map(o => ({
      ...parseOfficerName(o.name),
      role: o.officer_role ?? null,
      appointed_on: o.appointed_on ?? null,
    }));

    const sicDescription = companySicCodes.map(describeSicCode).join(', ') || 'Unknown';

    results.push({
      companyName,
      companyNumber,
      domain: null,   // resolved post-scoring only, to avoid wasting Serper credits
      link: null,
      location,
      sicCodes: companySicCodes,
      sicDescription,
      dateOfCreation: item.date_of_creation ?? null,
      companyType: item.company_type ?? null,
      officers: parsedOfficers,
    });

    console.log(`[ch_search] Found: ${companyName} (${companyNumber}) | ${parsedOfficers.length} officers`);
  }

  console.log(`[ch_search] Returning ${results.length} new companies from Companies House`);
  return results;
}
