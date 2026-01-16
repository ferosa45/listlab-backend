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
  doc
    .fontSize(22)
    .text("FAKTURA", { align: "center" })
    .moveDown(2);

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

  doc.fontSize(13).text("Souhrn", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(11);
  doc.text(
    `Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} Kč`
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
