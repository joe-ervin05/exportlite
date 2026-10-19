import Database from "better-sqlite3";

const firstNames =
  "Amelia Benjamin Charlotte Daniel Elena Felix Grace Hassan Isla Javier Kai Lucia Mateo Nadia Oliver Priya Quinn Rafael Sofia Theo Uma Victor Willow Xavier Yara Zoe André Chloé José Léa Mei Renée Saanvi Søren Tomás Zain Aisha Akira Anika Arjun Beatriz Camila David Emilia Fatima Gabriel Hana Ibrahim Julia Keiko Liam Linh Louis Maria Noah Omar Oscar Pablo Samira Sara Yusuf".split(
    " ",
  );
const lastNames =
  "Adams Ahmed Ali Anderson Baker Bennett Brooks Brown Campbell Carter Chen Clark Cohen Collins Costa Cruz Davis Diaz Dubois Edwards Evans Flores Garcia Green Hall Harris Hassan Hill Hughes Ibrahim Jackson James Johnson Jones Khan Kim King Kumar Lee Lewis Li Lopez Martin Martinez Miller Mitchell Moore Morgan Morris Murphy Nguyen Patel Perez Phillips Reed Rivera Roberts Robinson Rodriguez Rossi Ruiz Sato Scott Shah Singh Smith Taylor Thomas Thompson Torres Turner Walker Wang White Williams Wilson Wong Wood Wright Young Zhang".split(
    " ",
  );
const actions = [
  "address update",
  "billing question",
  "delivery change",
  "exchange",
  "invoice copy",
  "missing item",
  "order confirmation",
  "payment review",
  "replacement",
  "return",
  "service appointment",
  "warranty claim",
];
const products = [
  "air filter",
  "backpack",
  "bath towel",
  "bike light",
  "coffee grinder",
  "cotton shirt",
  "desk lamp",
  "door handle",
  "garden hose",
  "glass bottle",
  "headphones",
  "hiking boots",
  "kitchen scale",
  "linen duvet",
  "monitor stand",
  "notebook",
  "office chair",
  "phone charger",
  "plant pot",
  "power adapter",
  "rain jacket",
  "running shoes",
  "safety gloves",
  "shelf bracket",
  "storage basket",
  "travel mug",
  "wall clock",
  "water filter",
  "window blind",
  "wireless mouse",
];
const colors =
  "amber black blue brass bronze charcoal coral cream gold gray green ivory lilac navy olive orange pink purple red silver teal white yellow".split(
    " ",
  );
const streets =
  "Ash Birch Cedar Cherry Cypress Elm Forest Garden Hawthorn Hill Lake Laurel Linden Maple Meadow Oak Park Pine River Spruce Summit Valley Walnut Willow".split(
    " ",
  );
const cities = [
  "Austin",
  "Boston",
  "Calgary",
  "Chicago",
  "Denver",
  "Dublin",
  "Edinburgh",
  "Halifax",
  "Leeds",
  "London",
  "Montréal",
  "Ottawa",
  "Portland",
  "Québec",
  "San Diego",
  "Seattle",
  "Toronto",
  "Vancouver",
  "Victoria",
  "Wellington",
];
const outcomes = [
  "awaiting customer reply",
  "carrier investigation open",
  "confirmed by email",
  "credit issued",
  "customer accepted the update",
  "escalated for review",
  "follow-up scheduled",
  "item reserved",
  "label sent",
  "new tracking supplied",
  "pending warehouse check",
  "resolved during the call",
];

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function variedRows(width, seed) {
  const random = randomSource(seed);
  const integer = (limit) => Math.floor(random() * limit);
  const pick = (values) => values[integer(values.length)];
  const code = () =>
    Math.floor(random() * 4_294_967_296)
      .toString(36)
      .padStart(7, "0");
  const money = () =>
    `${integer(1200) + 1}.${String(integer(100)).padStart(2, "0")}`;
  const date = () =>
    `2026-${String(integer(10) + 1).padStart(2, "0")}-${String(integer(28) + 1).padStart(2, "0")}`;
  const shortNotes = [
    () => `Paid $${money()}; ref ${code()}.`,
    () => `INV-${code()}: $${money()} due.`,
    () => `Order ${code()}: ${pick(outcomes)}.`,
    () => `Return ${code()}: ${pick(products)}.`,
    () => `${code()}: call ${pick(firstNames)} after ${integer(9) + 8}:00.`,
    () => `Deliver ${code()} to ${pick(cities)}.`,
    () => `${code()}: ${integer(8) + 1} ${pick(products)} ready.`,
    () => `${date()} credit $${money()} (${code()}).`,
  ];
  const clauses = [
    () =>
      `${date()}: customer requested ${pick(actions)} for order ${code()}-${code()}.`,
    () =>
      `Invoice INV-${code()} totals $${money()}; payment reference ${code()}${code()}.`,
    () =>
      `Ship ${integer(8) + 1} ${pick(colors)} ${pick(products)} units, SKU ${code()}, to ${integer(9900) + 1} ${pick(streets)} Street, ${pick(cities)}.`,
    () =>
      `The ${pick(products)} arrived ${integer(12) + 1} days after dispatch; condition recorded as "${pick(["acceptable", "damaged packaging", "incorrect size", "missing accessory", "unopened"])}".`,
    () =>
      `Agent ${pick(firstNames)} ${pick(lastNames)} checked ticket ${code()}; ${pick(outcomes)}.`,
    () =>
      `Contact ${code()}@${pick(["example.com", "example.net", "example.org"])} after ${integer(9) + 8}:${pick(["00", "15", "30", "45"])}; customer prefers ${pick(["email", "phone", "text"])}.`,
    () =>
      `Tracking https://example.com/track/${code()}${code()}?shipment=${code()} was updated on ${date()}.`,
    () =>
      `A refund of $${money()} was ${pick(["approved", "requested", "rejected", "reversed"])} under case ${code()}-${code()}; original method retained.`,
    () =>
      `Requested a ${pick(colors)} ${pick(products)} with ${pick(["standard", "express", "weekend", "scheduled"])} delivery to ${pick(cities)}.`,
    () =>
      `Notes from ${date()}: "${pick(["Please ring the bell twice", "Leave with reception", "Call before arriving", "Use the side entrance", "Packaging must stay sealed", "A gift receipt is required"])}"; ${pick(outcomes)}.`,
    () =>
      `Customer reported ${pick(["an intermittent fault", "a loose connector", "an unexpected charge", "a scratched finish", "a delayed collection", "a mismatch in the description"])} after ${integer(90) + 1} days of use.`,
    () =>
      `Inventory lot ${code()}-${code()} has ${integer(180)} units available; next review ${date()}.`,
    () =>
      `Size ${pick(["XS", "S", "M", "L", "XL", "XXL"])} was exchanged for ${pick(["S", "M", "L", "XL"])}; adjustment $${money()} and handling fee $${integer(15)}.00.`,
    () =>
      `Delivery instructions: ${pick(["Montréal — entrée côté cour", "東京 — 受付に預けてください", "München — bitte anrufen", "São Paulo — portaria", "Québec — après 17 heures", "Zürich — Empfang"])}. Case ${code()}.`,
    () =>
      `Audit event ${code()}${code()}${code()}: source=${pick(["portal", "phone", "email", "store", "mobile"])}; session=${code()}${code()}; status=${pick(outcomes)}.`,
    () =>
      `Follow-up ${date()} for ${pick(firstNames)} ${pick(lastNames)}: confirm the ${pick(products)} replacement and quote ${code()}-${code()}.`,
  ];
  return (id) => {
    const name = `${pick(firstNames)}${integer(4) === 0 ? ` ${String.fromCharCode(65 + integer(26))}.` : ""} ${pick(lastNames)}`;
    let note = null;
    if (id % 7 !== 0 && width < 128) {
      note = pick(shortNotes)();
    } else if (id % 7 !== 0) {
      let target = Math.max(8, Math.round(width * (0.5 + random())));
      // Rare longer notes occur independently of row position.
      if (width >= 256 && random() < 0.01) target *= 4 + integer(9);
      const parts = [`${code()} ${pick(actions)}: `];
      let length = parts[0].length;
      while (length < target) {
        const clause = pick(clauses)();
        parts.push(integer(6) === 0 ? `\n${clause}` : clause);
        length += clause.length + 1;
      }
      note = parts.join(" ").slice(0, target);
    }
    return { id, name, note, active: random() < 0.72 ? 1 : 0 };
  };
}

export function createFixture(path, rows, { width, profile, seed }) {
  const db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE data (id INTEGER PRIMARY KEY, name TEXT, note TEXT, active INTEGER)",
    );
    if (profile === "repeated") {
      const payload = '雪 "line"\n'
        .repeat(Math.ceil(width / 9))
        .slice(0, width);
      db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < @rows)
        INSERT INTO data SELECT x, printf('user-%08d', x),
          CASE WHEN x % 7 = 0 THEN NULL ELSE @payload END, x % 2 FROM n`).run({
        rows,
        payload,
      });
    } else {
      const next = variedRows(width, seed);
      const insert = db.prepare(
        "INSERT INTO data VALUES (@id, @name, @note, @active)",
      );
      db.transaction(() => {
        for (let id = 1; id <= rows; id++) insert.run(next(id));
      })();
    }
    const sizes = db
      .prepare(`SELECT length(CAST(note AS BLOB)) AS bytes, count(*) AS count
      FROM data WHERE note IS NOT NULL GROUP BY bytes ORDER BY bytes`)
      .all();
    const nonNull = sizes.reduce((sum, group) => sum + group.count, 0);
    const quantile = (fraction) => {
      let count = 0;
      for (const group of sizes) {
        count += group.count;
        if (count >= Math.ceil(nonNull * fraction)) return group.bytes;
      }
      return null;
    };
    const statistics = {
      ...db
        .prepare(
          "SELECT count(DISTINCT name) AS distinctNames, count(DISTINCT note) AS distinctNonNullNotes, sum(note IS NULL) AS nullNotes FROM data",
        )
        .get(),
      noteUtf8Bytes: {
        min: sizes[0]?.bytes ?? null,
        mean: nonNull
          ? sizes.reduce((sum, group) => sum + group.bytes * group.count, 0) /
            nonNull
          : null,
        p50: quantile(0.5),
        p95: quantile(0.95),
        max: sizes.at(-1)?.bytes ?? null,
      },
      samples: db.prepare("SELECT * FROM data ORDER BY id LIMIT 3").all(),
    };
    return {
      expectedJsonBytes: db
        .prepare(`SELECT coalesce(sum(length(CAST(json_object(
        'id',id,'name',name,'note',note,'active',active
      ) AS BLOB))),0) + max(count(*)-1,0) + 2 FROM data`)
        .pluck()
        .get(),
      firstRecordBytes: Buffer.byteLength(
        `[${JSON.stringify(statistics.samples[0])}`,
      ),
      sqliteVersion: db.prepare("SELECT sqlite_version()").pluck().get(),
      statistics,
    };
  } finally {
    db.close();
  }
}
