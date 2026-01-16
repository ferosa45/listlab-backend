import PDFDocument from "pdfkit";

/**
 * Vytvoří PDF fakturu a vrátí PDFKit dokument
 */
export function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
  });

  // ===== HLAVIČKA =====
  doc
    .fontSize(20)
    .text("FAKTURA", { align: "center" })
    .moveDown(2);

  // ===== ZÁKLADNÍ INFO =====
  doc.fontSize(12);
  doc.text(`Číslo faktury: ${invoice.number}`);
  doc.text(`Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`);
  doc.moveDown();

  // ===== ODBĚRATEL =====
  doc.fontSize(14).text("Odběratel", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(12);
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

  // ===== ČÁSTKA =====
  doc.fontSize(14).text("Souhrn", { underline: true });
  doc.moveDown(0.5);

  doc.fontSize(12);
  doc.text(`Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} Kč`);

  doc.moveDown(3);

  // ===== PATIČKA =====
  doc
    .fontSize(10)
    .fillColor("gray")
    .text("Vygenerováno systémem ListLab", {
      align: "center",
    });

  doc.fillColor("black");

  return doc;
}
