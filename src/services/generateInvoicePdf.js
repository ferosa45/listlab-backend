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

  // ✅ SPRÁVNÁ CESTA K FONTU
  const fontPath = path.join(
    __dirname,
    "../../fonts/DejaVuSans.ttf"
  );

  doc.font(fontPath);

  // ===== HLAVIČKA =====
  // ===== HLAVIČKA =====
doc
  .fontSize(20)
  .characterSpacing(1.5)   // 🔥 ROZTAŽENÍ PÍSMEN
  .text("FAKTURA", { align: "center" })
  .characterSpacing(0);    // ⬅️ vždy vrátit zpět


  doc.fontSize(11);
  doc.text(`Číslo faktury: ${invoice.number}`);
  doc.text(
    `Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`
  );

  doc.moveDown(2);

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
doc.moveDown(1.5);
doc.fontSize(13).text("Položky", { underline: true });
doc.moveDown(0.5);

// Hlavička tabulky
doc.fontSize(11);
doc.text("Popis", 50, doc.y, { continued: true });
doc.text("Množství", 350, doc.y, { continued: true });
doc.text("Cena", 450, doc.y);

// Čára
doc
  .moveTo(50, doc.y + 2)
  .lineTo(545, doc.y + 2)
  .stroke();

doc.moveDown(0.5);

// Řádek položky
doc.text("TEAM licence – ListLab", 50, doc.y, { continued: true });
doc.text("1", 370, doc.y, { continued: true });
doc.text(`${(invoice.amountPaid / 100).toFixed(2)} Kč`, 450, doc.y);


  // ===== SOUHRN =====
doc.moveDown(2);
doc.fontSize(13).text("Souhrn", { underline: true });
doc.moveDown(0.5);

doc
  .fontSize(12)
  .text(
    `Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} Kč`,
    { align: "right" }
  );


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
