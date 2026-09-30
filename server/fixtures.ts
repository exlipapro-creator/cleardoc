/**
 * ClearDoc Controlled Test Fixture Suite
 * Generates verified, reproducible PDF and image fixtures for automated testing and user demonstrations.
 */
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

export async function generateDraftPdfFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  // Page 1
  const page1 = doc.addPage([595, 842]); // A4
  page1.drawText('QUARTERLY FINANCIAL REPORT — Q3', {
    x: 50,
    y: 780,
    size: 18,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.2),
  });

  page1.drawText('Executive Summary', {
    x: 50,
    y: 740,
    size: 14,
    font: boldFont,
    color: rgb(0.2, 0.3, 0.4),
  });

  const bodyParagraph =
    'During the third quarter, operations showed resilient momentum across all business units. Total revenue expanded by 14.8% year-over-year, driven by enterprise platform adoption and enhanced customer retention metrics. Operating margin improved by 180 basis points due to disciplined cost management.';
  
  page1.drawText(bodyParagraph, {
    x: 50,
    y: 710,
    size: 10,
    font,
    color: rgb(0.2, 0.2, 0.2),
    maxWidth: 495,
    lineHeight: 14,
  });

  // Diagonal DRAFT watermark
  page1.drawText('DRAFT', {
    x: 130,
    y: 280,
    size: 96,
    font: boldFont,
    color: rgb(0.85, 0.85, 0.85),
    rotate: degrees(45),
  });

  // Page 2
  const page2 = doc.addPage([595, 842]);
  page2.drawText('Balance Sheet Overview', {
    x: 50,
    y: 780,
    size: 16,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.2),
  });

  page2.drawText(
    'Consolidated cash reserves reached $42.5M, reflecting robust free cash flow generation. Working capital metrics remained stable, and debt-to-equity ratio decreased to 0.41.',
    {
      x: 50,
      y: 740,
      size: 10,
      font,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: 495,
      lineHeight: 14,
    }
  );

  // Diagonal DRAFT watermark on page 2
  page2.drawText('DRAFT', {
    x: 130,
    y: 280,
    size: 96,
    font: boldFont,
    color: rgb(0.85, 0.85, 0.85),
    rotate: degrees(45),
  });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

export async function generateConfidentialPdfFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([612, 792]); // US Letter
  page.drawText('PATENT INVENTOR DISCLOSURE AGREEMENT', {
    x: 60,
    y: 720,
    size: 16,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });

  page.drawText(
    'This non-disclosure agreement governs the proprietary methodologies, algorithmic formulations, and architecture diagrams disclosed during evaluation discussions.',
    {
      x: 60,
      y: 680,
      size: 11,
      font,
      color: rgb(0.25, 0.25, 0.25),
      maxWidth: 492,
      lineHeight: 16,
    }
  );

  // Large diagonal CONFIDENTIAL watermark
  page.drawText('CONFIDENTIAL', {
    x: 80,
    y: 220,
    size: 64,
    font: boldFont,
    color: rgb(0.88, 0.88, 0.88),
    rotate: degrees(40),
  });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

export async function generateCleanPdfFixture(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const page = doc.addPage([595, 842]);
  page.drawText('FORMAL TECHNICAL SPECIFICATION', {
    x: 50,
    y: 780,
    size: 18,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.2),
  });

  page.drawText(
    'This document represents a finalized publication release. No preliminary markings or watermarks exist in this document stream.',
    {
      x: 50,
      y: 740,
      size: 11,
      font,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: 495,
      lineHeight: 16,
    }
  );

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

export async function generateSampleImageFixture(): Promise<Buffer> {
  // Create an 800x600 SVG with text watermark and render to PNG with Sharp
  const svg = `
    <svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#f8fafc;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#e2e8f0;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#grad)" />
      
      <text x="60" y="80" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#0f172a">
        Architectural Blueprint — Sector 4
      </text>
      
      <rect x="60" y="120" width="680" height="380" fill="#ffffff" stroke="#cbd5e1" stroke-width="2" rx="8" />
      <line x1="100" y1="180" x2="700" y2="180" stroke="#e2e8f0" stroke-width="1.5" />
      <line x1="100" y1="260" x2="700" y2="260" stroke="#e2e8f0" stroke-width="1.5" />
      <line x1="100" y1="340" x2="700" y2="340" stroke="#e2e8f0" stroke-width="1.5" />
      
      <!-- Watermark stamp -->
      <g transform="translate(400, 300) rotate(-30)">
        <rect x="-180" y="-35" width="360" height="70" fill="none" stroke="#ef4444" stroke-width="4" stroke-opacity="0.3" rx="8" />
        <text x="0" y="14" font-family="Arial, sans-serif" font-size="44" font-weight="bold" fill="#ef4444" fill-opacity="0.3" text-anchor="middle">
          SAMPLE COPY
        </text>
      </g>
    </svg>
  `;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}
