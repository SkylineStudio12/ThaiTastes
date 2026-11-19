// The one list of tools. MCP tools/list, the REST routes, input validation and the OpenAPI document are all built
// from it, so the two paths cannot drift. Each tool runs as the Postgres function ai_<name> (see migration 000006).
// Descriptions stay under 300 characters and parameter descriptions under 700: ChatGPT Actions cut anything longer.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const bool = (description) => ({ type: 'boolean', description });
const orNull = (s) => ({ ...s, type: [s.type, 'null'] });
const date = (description) => str(description, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const REGION = str('Region key from get_context: nord, centru, sud, est, isaan or dulci (sweets and drinks).', { maxLength: 20 });
const STAGE = str('Trip stage key from get_context, for example bkk or cnx.', { maxLength: 20 });
const paging = {
  limit: int('How many to return. Default 50.', 1, 200),
  offset: int('Skip this many; use next_offset from the previous page.', 0, 100000),
};
const entryFields = (nullable) => {
  const n = nullable ? orNull : (s) => s;
  return {
    dish_id: n(str('Id of a dish from list_dishes. Prefer this over dish_name.', { maxLength: 40 })),
    dish_name: n(str('Free-text dish name, only when the dish is not in list_dishes.', { maxLength: 200 })),
    place_id: n(str('Id of a place from list_places. Prefer this over place_name.', { maxLength: 40 })),
    place_name: n(str('Free-text place name, only when the place is not in list_places.', { maxLength: 200 })),
    date: date('Day it was eaten, YYYY-MM-DD in Thailand time.' + (nullable ? '' : ' Default: today.')),
    price_thb: n(int('Price in Thai baht.', 0, 1000000)),
    spice: n(int('How spicy it was, 0 (none) to 10.', 0, 10)),
    again: n(bool('Would they order it again.')),
    note: n(str('Short note in the user\'s words.', { maxLength: 2000 })),
  };
};
const UPDATED_AT = str('The updated_at value of the entry as you last read it. If the entry changed since, nothing is written and the current record is returned.', { maxLength: 40 });

export const TOOLS = [
  { name: 'get_context', write: false, title: 'Get trip context',
    description: 'Start here. Returns today\'s date in Thailand, the current trip stage, the itinerary, region keys, journal counts, the 5 most recent entries, and each person\'s last known location with its age in minutes.',
    input: obj({}) },
  { name: 'search_entries', write: false, title: 'Search journal entries',
    description: 'Find journal entries (things Greg and Andra ate). All filters are optional and combine with AND. Newest first, paged.',
    input: obj({
      query: str('Free text, matched against dish name (romanised or Thai), place name and note.', { maxLength: 200 }),
      date_from: date('Earliest date, YYYY-MM-DD.'), date_to: date('Latest date, YYYY-MM-DD.'),
      stage: STAGE, region: REGION,
      dish_id: str('Only entries for this dish.', { maxLength: 40 }), place_id: str('Only entries at this place.', { maxLength: 40 }),
      min_rating: int('At least one of the two ratings is this or higher.', 1, 5),
      max_rating: int('At least one of the two ratings is this or lower.', 1, 5),
      min_spice: int('Spice level at least this.', 0, 10), max_spice: int('Spice level at most this.', 0, 10),
      again: bool('Only entries marked "would order again" (true) or "would not" (false).'),
      author: str('Who created the entry.', { enum: ['greg', 'andra', 'claude', 'chatgpt'] }),
      ...paging }) },
  { name: 'get_entry', write: false, title: 'Get one entry',
    description: 'Returns one journal entry by id, including its updated_at, which update_entry needs.',
    input: obj({ id: str('Entry id.', { maxLength: 40 }) }, ['id']) },
  { name: 'add_entry', write: true, title: 'Add a journal entry',
    description: 'Logs something that was eaten. Use only when the user says they ate it. Give dish_id (or dish_name) and, if known, the place. Does not take ratings: use rate_entry once the user states one. Returns the new entry.',
    input: obj(entryFields(false)) },
  { name: 'update_entry', write: true, title: 'Change a journal entry',
    description: 'Changes fields of an entry; fields you leave out stay as they are, null clears one. Needs expected_updated_at. If the result has conflict: true, nothing was written: merge your change into "current" and retry with its updated_at.',
    input: obj({ id: str('Entry id.', { maxLength: 40 }), expected_updated_at: UPDATED_AT, ...entryFields(true) }, ['id', 'expected_updated_at']) },
  { name: 'rate_entry', write: true, title: 'Set a rating',
    description: 'Sets Greg\'s or Andra\'s rating (1 to 5) on an entry. Only call this when the user has told you the rating for that person in this conversation. Never guess, infer or copy a rating.',
    input: obj({
      id: str('Entry id.', { maxLength: 40 }),
      person: str('Whose rating this is.', { enum: ['greg', 'andra'] }),
      rating: orNull(int('1 (bad) to 5 (excellent). null removes the rating.', 1, 5)),
      expected_updated_at: { ...UPDATED_AT, description: 'Optional. ' + UPDATED_AT.description } }, ['id', 'person', 'rating']) },
  { name: 'list_dishes', write: false, title: 'List dishes',
    description: 'Lists the dish catalogue with Thai names, region, favourite flag, times eaten and average ratings. Use tried: false for dishes still to try. Call before add_entry to find the dish id.',
    input: obj({
      query: str('Free text, matched against the romanised name, Thai name and description.', { maxLength: 200 }),
      region: REGION, tried: bool('true: only dishes already eaten. false: only dishes not eaten yet.'),
      fav: bool('true: only favourites.'), ...paging }) },
  { name: 'add_dish', write: true, title: 'Add a dish',
    description: 'Adds a dish to the catalogue when the user asks for it or has eaten something that is not listed. If the name already exists, the existing dish is returned. To propose a dish instead, use add_suggestion.',
    input: obj({
      name: str('Romanised name, for example "Khao soi".', { minLength: 1, maxLength: 120 }),
      thai: str('Name in Thai script, if you are sure of it.', { maxLength: 120 }),
      description: str('One short line describing the dish.', { maxLength: 500 }),
      region: REGION }, ['name', 'region']) },
  { name: 'list_places', write: false, title: 'List places',
    description: 'Lists restaurants, stalls and markets in the journal, with visit counts. Filter by stage or text, or pass near_lat and near_lng (for example from get_latest_location) to sort by distance.',
    input: obj({
      query: str('Free text, matched against name, Thai name, address and note.', { maxLength: 200 }),
      stage: STAGE,
      near_lat: { type: 'number', description: 'Latitude to measure distance from.', minimum: -90, maximum: 90 },
      near_lng: { type: 'number', description: 'Longitude to measure distance from.', minimum: -180, maximum: 180 },
      radius_km: { type: 'number', description: 'With near_lat and near_lng: only places within this many km. Default 5.', minimum: 0.1, maximum: 500 },
      ...paging }) },
  { name: 'add_place', write: true, title: 'Add a place',
    description: 'Adds a place when the user asks for it or ate somewhere that is not listed. If a place with that name exists in the stage, it is returned instead. To propose a place, use add_suggestion.',
    input: obj({
      name: str('Name of the place.', { minLength: 1, maxLength: 160 }),
      thai: str('Name in Thai script, if known.', { maxLength: 160 }),
      address: str('Address or how to find it.', { maxLength: 300 }),
      stage: { ...STAGE, description: STAGE.description + ' Default: the current stage.' },
      lat: { type: 'number', description: 'Latitude. Send together with lng, and only if you are sure of it.', minimum: -90, maximum: 90 },
      lng: { type: 'number', description: 'Longitude.', minimum: -180, maximum: 180 },
      note: str('Short note about the place.', { maxLength: 1000 }) }, ['name']) },
  { name: 'toggle_fav', write: true, title: 'Mark a favourite dish',
    description: 'Adds a dish to the favourites or removes it. Pass fav to set it explicitly; leave it out to flip the current state. Only on the user\'s request.',
    input: obj({ dish_id: str('Dish id from list_dishes.', { maxLength: 40 }), fav: bool('true: favourite. false: not a favourite.') }, ['dish_id']) },
  { name: 'get_stats', write: false, title: 'Get statistics',
    description: 'Returns journal statistics: average ratings and spice, total spend, entries and spend per stage, best-rated and most-eaten dishes, and how many dishes are still to try in each region.',
    input: obj({}) },
  { name: 'add_suggestion', write: true, title: 'Suggest something',
    description: 'Proposes a dish, a place or a note without changing the journal. It lands in the app\'s inbox, where Greg or Andra accept or dismiss it. Use this for your own ideas and recommendations.',
    input: obj({
      kind: str('What you are proposing.', { enum: ['dish', 'place', 'note'] }),
      payload: { type: 'object', additionalProperties: true,
        description: 'dish: {rom (romanised name), th?, d? (description), region, reason?}. place: {name, th?, address?, stage, lat?, lng?, note?, reason?}. note: {text, dish_id?, place_id?, entry_id?}. region and stage are keys from get_context.' } },
      ['kind', 'payload']) },
  { name: 'list_suggestions', write: false, title: 'List suggestions',
    description: 'Lists suggestions made by the assistants and whether they were accepted or dismissed. Check it before suggesting, so you do not repeat one.',
    input: obj({ status: str('Only suggestions in this state.', { enum: ['new', 'accepted', 'dismissed'] }), ...paging }) },
  { name: 'get_latest_location', write: false, title: 'Get last known location',
    description: 'Returns each person\'s last known position with age_minutes. It is recorded only while the app is open on the phone, so it can be old: say how old it is, and do not assume they are still there.',
    input: obj({}) },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const INSTRUCTIONS = [
  'ThaiTastes is the food journal Greg and Andra keep on their trip through Thailand. You are writing into their real journal.',
  'Call get_context first: it gives today\'s date in Thailand, the current stage and the keys used elsewhere.',
  'Log an entry only for something the user says they ate. Look up the dish and place ids with list_dishes and list_places before add_entry.',
  'Never invent a rating. Call rate_entry only when the user states the rating for a named person.',
  'Your own ideas (a dish to try, a place nearby, a correction) go through add_suggestion, not into the journal.',
  'update_entry may answer with conflict: true. Then nothing was written: merge into the returned record and retry.',
  'Keep Thai script exactly as it is.',
].join(' ');

// A small JSON Schema checker for the subset used above. Returns a list of problems (empty when valid).
export function validate(schema, value, path = '') {
  const errs = [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const fits = types.includes(actual) || (actual === 'integer' && types.includes('number'));
  const at = path || 'arguments';
  if (!fits) return [`${at} must be ${types.join(' or ')}`];
  if (value === null) return errs;
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${at} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at} is longer than ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at} has the wrong format`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at} must be at most ${schema.maximum}`);
  }
  if (actual === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${path ? path + '.' : ''}${k} is required`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[k];
      if (sub) errs.push(...validate(sub, v, path ? `${path}.${k}` : k));
      else if (schema.additionalProperties === false) errs.push(`${path ? path + '.' : ''}${k} is not a known field`);
    }
  }
  return errs;
}
