export default async function basicScenario({ page, recorder }) {
  await recorder.mark("scenario:start");

  // Replace these selectors with app-specific steps.
  await page.waitForLoadState("domcontentloaded");
  await recorder.wait(500, "initial paint");

  await recorder.mark("scenario:end");
}
