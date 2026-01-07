import PDFDocument from "pdfkit";

export function generateInvoicePdf(invoice) {
  const doc = new PDFDocument({ margin: 50 });

  // HLAVIČKA
  doc
    .fontSize(20)
    .text("FAKTURA", { align: "right" })
    .moveDown();

  doc
    .fontSize(10)
    .text(`Faktura č.: ${invoice.number}`)
    .text(`Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`)
    .moveDown();

  // DODAVATEL
  doc.fontSize(12).text("Dodavatel", { underline: true });
  doc
    .fontSize(10)
    .text("AI School Tools s.r.o.")
    .text("IČO: XXXXXXXX")
    .text("Sídlo: …")
    .moveDown();

  // ODBĚRATEL
  doc.fontSize(12).text("Odběratel", { underline: true });
  doc
    .fontSize(10)
    .text(invoice.billingName)
    .text(invoice.billingStreet)
    .text(`${invoice.billingZip} ${invoice.billingCity}`)
    .text(`IČO: ${invoice.billingIco}`)
    .moveDown();

  // POLOŽKY
  doc.fontSize(12).text("Položky", { underline: true }).moveDown(0.5);

  invoice.items.forEach((item) => {
    doc
      .fontSize(10)
      .text(
        `${item.description} – ${item.quantity}× ${(item.amount / 100).toFixed(2)}`
      );
  });

  doc.moveDown();

  // SOUČET
  doc
    .fontSize(12)
    .text(
      `Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} ${
        invoice.currency.toUpperCase()
      }`,
      { align: "right" }
    );

  doc.end();
  return doc;
}
