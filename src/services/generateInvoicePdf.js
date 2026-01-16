import PDFDocument from "pdfkit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
  });

  // ===== FONT =====
  const fontPath = path.join(__dirname, "../../fonts/DejaVuSans.ttf");
  doc.font(fontPath);

  // ===== HLAVIČKA =====
// ===== HLAVIČKA =====
doc
  .font(fontPath)
  .fontSize(24)
  .text("FAKTURA", {
    align: "center",
  });

doc.moveDown(2);


  // ===== ZÁKLADNÍ INFO =====
  doc.fontSize(11);
  doc.text(`Číslo faktury: ${invoice.number}`);
  doc.text(
    `Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`
  );

  doc.moveDown(2);

  // ===== ODBĚRATEL =====
  doc.fontSize(13).text("Odběratel", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(11);
  doc.text(invoice.billingName);
  doc.text(invoice.billingStreet);
  doc.text(`${invoice.billingZip} ${invoice.billingCity}`);
  doc.text(invoice.billingCountry);

  if (invoice.billingIco) {
    doc.text(`IČO: ${invoice.billingIco}`);
  }

  if (invoice.billingEmail) {
    doc.text(`Email: ${invoice.billingEmail}`);
  }

  doc.moveDown(2);

 // ===== POLOŽKY =====
doc.moveDown(2);
doc.fontSize(13).text("Položky", { underline: true });
doc.moveDown(1);

// Hlavička tabulky
const tableTop = doc.y;

doc.fontSize(11)
  .text("Popis", 50, tableTop)
  .text("Množství", 400, tableTop, { width: 60, align: "right" })
  .text("Cena", 480, tableTop, { width: 80, align: "right" });

// Oddělovací čára
doc
  .moveTo(50, tableTop + 15)
  .lineTo(550, tableTop + 15)
  .stroke();

doc.moveDown(1);

// Řádek položky
const rowY = doc.y;

doc.fontSize(11)
  .text("TEAM licence – ListLab", 50, rowY)
  .text(
    quantity.toString(),
    400,
    rowY,
    { width: 60, align: "right" }
  )
  .text(
    `${price.toFixed(2)} Kč`,
    480,
    rowY,
    { width: 80, align: "right" }
  );


  doc.moveDown(2);

  // ===== SOUHRN =====
  doc.fontSize(13).text("Souhrn", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(11);
  doc.text(
    `Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} Kč`,
    { align: "right" }
  );

  // ===== PATIČKA =====
  doc.moveDown(3);
  doc
    .fontSize(9)
    .fillColor("gray")
    .text("Vygenerováno systémem ListLab", {
      align: "center",
    });

  doc.fillColor("black");

  return doc;
}
