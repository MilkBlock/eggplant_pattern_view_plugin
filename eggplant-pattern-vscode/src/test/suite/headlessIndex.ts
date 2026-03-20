import Mocha = require("mocha");

export function run(testFile: string): Promise<void> {
  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 30_000
  });

  mocha.addFile(testFile);

  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}
