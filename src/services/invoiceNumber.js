export async function generateInvoiceNumber(tx) {
  const year = new Date().getFullYear();

  const last = await tx.invoice.findFirst({
    where: { year },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  const nextSequence = (last?.sequence ?? 0) + 1;

  return {
    year,
    sequence: nextSequence,
    number: `${year}-${String(nextSequence).padStart(6, "0")}`,
  };
}
