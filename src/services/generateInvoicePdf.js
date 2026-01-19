import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  const fontPath = path.join(__dirname, "../../fonts/DejaVuSans.ttf");
  doc.registerFont("Regular", fontPath);
  doc.registerFont("Bold", fontPath);

  doc.font("Regular");

  // ========================
  // KONSTANTY
  // ========================
  const MARGIN = 50;
  const PAGE_WIDTH = doc.page.width - MARGIN * 2;

  // ========================
  // HLAVIČKA
  // ========================
  drawHeader(doc, invoice, MARGIN, PAGE_WIDTH);

  // ========================
  // DODAVATEL / ODBĚRATEL
  // ========================
  drawParties(doc, invoice, MARGIN, PAGE_WIDTH);

  // ========================
  // POLOŽKY
  // ========================
  drawItemsTable(doc, invoice, MARGIN, PAGE_WIDTH);

  // ========================
  // SOUHRN
  // ========================
  drawSummary(doc, invoice, MARGIN, PAGE_WIDTH);

  // ========================
  // PATIČKA
  // ========================
  drawFooter(doc, invoice, MARGIN, PAGE_WIDTH);

  return doc;
}

// ======================================================
// SEKCEEES
// ======================================================

function drawHeader(doc, invoice, x, width) {
  doc.font("Bold").fontSize(24).text("ListLab", x, 50);

  doc.font("Regular").fontSize(11).fillColor("#555")
    .text("Faktura – daňový doklad", x, 80);

  doc.fillColor("#000").fontSize(10)
    .text(`Číslo faktury: ${invoice.number}`, x + width - 200, 55, { align: "right" })
    .text(`Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`, x + width - 200, 72, { align: "right" });

  if (invoice.periodStart && invoice.periodEnd) {
  doc.text(
    `Období předplatného: ${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`,
    x + width - 200,
    89,
    { align: "right" }
);

    doc.moveTo(x, 110).lineTo(x + width, 110).strokeColor("#e5e7eb").stroke();
}

function drawParties(doc, invoice, x, width) {
  const y = 130;

  // DODAVATEL
 doc.font("Bold").fontSize(11).text("Dodavatel", x, y);

doc.font("Regular").fontSize(10)
  .text("Ing. Ondřej Krčal", x, y + 33)
  .text("Čs. Armády 1199/26", x, y + 48)
  .text("748 01 Hlučín", x, y + 63)
  .text("IČO: 05241502", x, y + 78)
  .text("E-mail: info@listlab.cz", x, y + 93)
  .text("Telefon: 604 800 894", x, y + 108);


  // ODBĚRATEL
  const rightX = x + width / 2 + 20;

  doc.font("Bold").fontSize(11).text("Odběratel", rightX, y);
  doc.font("Regular").fontSize(10)
    .text(invoice.billingName, rightX, y + 18)
    .text(invoice.billingStreet, rightX, y + 33)
    .text(`${invoice.billingZip} ${invoice.billingCity}`, rightX, y + 48)
    .text(invoice.billingCountry || "", rightX, y + 63);

  if (invoice.billingIco) {
    doc.text(`IČO: ${invoice.billingIco}`, rightX, y + 78);
  }

  if (invoice.billingEmail) {
    doc.text(`E-mail: ${invoice.billingEmail}`, rightX, y + 93);
  }
}




function drawItemsTable(doc, invoice, x, width) {

  let y = 270;

  const cols = {
    name: x,
    qty: x + 280,
    price: x + 340,
    total: x + 430,
  };

  // skutečný konec tabulky
  const tableRightEdge = cols.total + 90; // 90 = šířka "Celkem"
  const tableWidth = tableRightEdge - x;

  // HLAVIČKA TABULKY
  doc.rect(x, y - 6, tableWidth, 26).fill("#f3f4f6");

  doc.fillColor("#000").font("Bold").fontSize(10);
  doc.text("Popis", cols.name, y);
  doc.text("Ks", cols.qty, y, { width: 40, align: "right" });
  doc.text("Cena", cols.price, y, { width: 70, align: "right" });
  doc.text("Celkem", cols.total, y, { width: 90, align: "right" });

  y += 30;
  doc.font("Regular");

  const quantity = 1;
  const price = invoice.amountPaid / 100;

  // POLOŽKA
  doc.text("TEAM licence – ListLab", cols.name, y);
  doc.text(quantity.toString(), cols.qty, y, { width: 40, align: "right" });
  doc.text(formatPrice(price), cols.price, y, { width: 70, align: "right" });
  doc.text(formatPrice(price), cols.total, y, { width: 90, align: "right" });

  y += 22;
  doc.moveTo(x, y)
     .lineTo(tableRightEdge, y)
     .strokeColor("#e5e7eb")
     .stroke();

  doc.y = y + 25;
}


function drawSummary(doc, invoice, x, width) {
  const y = doc.y;
  const right = x + width;

  const total = invoice.amountPaid / 100;

  doc.font("Bold").fontSize(13);

  doc.text("Celkem k úhradě:", right - 200, y, { width: 120, align: "right" });
  doc.text(formatPrice(total), right - 80, y, { align: "right" });
}


function drawFooter(doc, invoice, x, width) {
  doc.font("Regular").fontSize(9).fillColor("#666");

  doc.text("Nejsem plátce DPH.", x, 705);
  doc.text("Faktura byla uhrazena online prostřednictvím Stripe.", x, 720);
  doc.text("Vygenerováno systémem ListLab", x, 735);
  doc.text("Děkujeme za využití ListLab ❤️", x, 760, { align: "center", width });

  doc.fillColor("#000");
}

function formatPrice(value) {
  return `${Number(value).toFixed(2)} Kč`;
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("cs-CZ");
}

