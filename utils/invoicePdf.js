import PDFDocument from "pdfkit";
import path from "path";

export function generateInvoicePdf(invoice, res) {
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  // FONT
  doc.font("Helvetica");

  // -------------------------------
  // HLAVIČKA
  // -------------------------------
  doc
    .fontSize(20)
    .text("FAKTURA – DAŇOVÝ DOKLAD", { align: "center" })
    .moveDown(2);

  doc.fontSize(12);

  doc.text(`Číslo faktury: ${invoice.number}`);
  doc.text(`Datum vystavení: ${invoice.issuedAt.toLocaleDateString("cs-CZ")}`);
  doc.text(`Stav: ${invoice.status}`);
  doc.moveDown();

  // -------------------------------
  // DODAVATEL
  // -------------------------------
  doc.font("Helvetica-Bold").text("Dodavatel:");
  doc.font("Helvetica");

  doc.text("ListLab s.r.o.");
  doc.text("IČO: 12345678");
  doc.text("Ulice 1");
  doc.text("Praha");
  doc.moveDown();

  // -------------------------------
  // ODBĚRATEL
  // -------------------------------
  doc.font("Helvetica-Bold").text("Odběratel:");
  doc.font("Helvetica");

  doc.text(invoice.billingName);
  doc.text(`IČO: ${invoice.billingIco || "—"}`);
  doc.text(invoice.billingStreet);
  doc.text(`${invoice.billingZip} ${invoice.billingCity}`);
  doc.text(invoice.billingCountry);
  doc.moveDown();

  // -------------------------------
  // POLOŽKY
  // -------------------------------
  doc.font("Helvetica-Bold").text("Položky:");
  doc.moveDown(0.5);
  doc.font("Helvetica");

  invoice.items.forEach((item) => {
    doc.text(
      `${item.description} — ${item.quantity} × ${(item.amount / 100).toFixed(
        2
      )} Kč`
    );
  });

  doc.moveDown();

  // -------------------------------
  // SOUHRN
  // -------------------------------
  doc.font("Helvetica-Bold");
  doc.text(
    `Celkem zaplaceno: ${(invoice.amountPaid / 100).toFixed(2)} Kč`
  );

  doc.end();
}
