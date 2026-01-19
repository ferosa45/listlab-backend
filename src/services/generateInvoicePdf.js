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

  doc.font("Regular")
     .fontSize(11)
     .fillColor("#555")
     .text("Faktura – daňový doklad", x, 80);

  // ===== PRAVÝ BLOK =====
  let rightY = 55;
  const rightX = x + width - 200;
  const line = 15;

  doc.fillColor("#000").fontSize(10);

  doc.text(`Číslo faktury: ${invoice.number}`, rightX, rightY, {
    width: 200,
    align: "right",
  });
  rightY += line;

  doc.text(`Datum vystavení: ${formatDate(invoice.issuedAt)}`, rightX, rightY, {
    width: 200,
    align: "right",
  });
  rightY += line;

  if (invoice.periodStart && invoice.periodEnd) {
    doc.fillColor("#555")
       .text("Období předplatného:", rightX, rightY, {
         width: 200,
         align: "right",
       });
    rightY += line;

    doc.fillColor("#000")
       .text(
         `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`,
         rightX,
         rightY,
         { width: 200, align: "right" }
       );
    rightY += line;
  }
}




function drawParties(doc, invoice, x, width) {
  const startY = 155;
  const padding = 18;
  const line = 15;

  // začátek boxu
  const boxTop = startY - padding - 8;


  // ===== DODAVATEL =====
  doc.font("Bold").fontSize(11).text("Dodavatel", x, startY);

  let leftY = startY + 18;
  doc.font("Regular").fontSize(10);

  doc.text("Ing. Ondřej Krčal", x, leftY); leftY += line;
  doc.text("Čs. Armády 1199/26", x, leftY); leftY += line;
  doc.text("748 01 Hlučín", x, leftY); leftY += line;
  doc.text("IČO: 05241502", x, leftY); leftY += line;
  doc.text("E-mail: info@listlab.cz", x, leftY); leftY += line;
  doc.text("Telefon: 604 800 894", x, leftY);

  // ===== ODBĚRATEL =====
  const rightX = x + width / 2 + 20;

  doc.font("Bold").fontSize(11).text("Odběratel", rightX, startY);

  let rightY = startY + 18;
  doc.font("Regular").fontSize(10);

  doc.text(invoice.billingName, rightX, rightY); rightY += line;
  doc.text(invoice.billingStreet, rightX, rightY); rightY += line;
  doc.text(`${invoice.billingZip} ${invoice.billingCity}`, rightX, rightY); rightY += line;
  doc.text(invoice.billingCountry || "", rightX, rightY); rightY += line;

  if (invoice.billingIco) {
    doc.text(`IČO: ${invoice.billingIco}`, rightX, rightY);
    rightY += line;
  }

  if (invoice.billingEmail) {
    doc.text(`E-mail: ${invoice.billingEmail}`, rightX, rightY);
  }

  // ===== RÁMEČEK =====
  const boxBottom = Math.max(leftY, rightY) + padding;

  doc
    .rect(
      x - padding,
      boxTop,
      width + padding * 2,
      boxBottom - boxTop
    )
    .strokeColor("#e5e7eb")
    .lineWidth(1)
    .stroke();

  // posun kurzoru pod box
  doc.y = boxBottom + 15;
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
  doc.rect(x, y - 8, tableWidth, 26).fill("#f3f4f6");

doc.fillColor("#000").font("Bold").fontSize(10);
doc.text("Popis", cols.name, headerTextY);
doc.text("Ks", cols.qty, headerTextY, { width: 40, align: "right" });
doc.text("Cena", cols.price, headerTextY, { width: 70, align: "right" });
doc.text("Celkem", cols.total, headerTextY, { width: 90, align: "right" });

  y += 30;
  doc.font("Regular");

  const quantity = 1;
  const price = invoice.amountPaid / 100;

  // POLOŽKA
  doc.text("TEAM licence – ListLab", cols.name, y);
  doc.text(quantity.toString(), cols.qty, y, { width: 40, align: "right" });
  doc.text(formatPrice(price), cols.price, y, { width: 70, align: "right" });
  doc.text(formatPrice(price), cols.total, y, { width: 90, align: "right" });

  y += 26;
  doc.moveTo(x, y)
     .lineTo(tableRightEdge, y)
     .strokeColor("#e5e7eb")
     .stroke();

  doc.y = y + 20;
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

