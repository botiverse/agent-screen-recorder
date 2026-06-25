export default async function clickScenario({ recorder }) {
  await recorder.mark("scenario:start");
  await recorder.click("#go", { label: "click-go", contentW: 600 });
  await recorder.wait(250, "after click");
  await recorder.mark("scenario:end");
}
