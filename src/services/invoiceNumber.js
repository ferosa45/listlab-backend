import { prisma } from "../lib/prisma.js";

export async function generateInvoiceNumber(tx) {
  const db = tx || prisma;
  const year = new Date().getFullYear();

  try {
    const last = await db.invoice.findFirst({
      where: { 
        number: { startsWith: `${year}-` }
      },
      orderBy: { createdAt: "desc" },
    });

    let nextSequence = 1;

    if (last) {
       const parts = last.number.split('-');
       if (parts.length === 2) {
         const seq = parseInt(parts[1]);
         if (!isNaN(seq)) {
           nextSequence = seq + 1;
         }
       }
    }

    // 🔥 ZMĚNA: Vracíme objekt s oběma údajii
    return {
    number: `${year}-${String(nextSequence).padStart(6, "0")}`,
    sequence: nextSequence
};

  } catch (err) {
    console.error("Chyba generování čísla faktury:", err);
    // Fallback
    const randomSeq = Math.floor(100000 + Math.random() * 900000);
    return {
        number: `${year}-${randomSeq}`,
        sequence: randomSeq
    };
  }
}