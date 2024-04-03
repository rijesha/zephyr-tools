/**
 * @author Jared Wolff <jared@circuitdojo.org>
 * @copyright Circuit Dojo LLC
 * @license Apache 2.0
 */

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import * as cp from "child_process";
import * as util from "util";
import * as os from "os";
import * as fs from "fs-extra";
import * as path from "path";
import * as unzip from "node-stream-zip";
import * as sevenzip from "7zip-bin";
import * as node7zip from "node-7z";

import { TaskManager } from "./taskmanager";
import { FileDownload } from "./download";
import * as commands from "./commands";
import * as helper from "./helper";

import { HelloWorldPanel, ColorsViewProvider } from "./panels/HelloWorldPanel";
import { ActiveProjectPanel } from "./panels/ActiveProjectPanel";
import { ProjectStatusView } from "./panels/ActiveProjectTreeView";

type CmdEntry = {
  cmd: string;
  usepath: boolean;
};

type DownloadEntry = {
  name: string;
  url: string;
  md5: string;
  cmd?: CmdEntry[];
  filename: string;
  clearTarget?: boolean;
};

type ToolChainPath = { [Name: string]: string };

// Platform
let platform: NodeJS.Platform = os.platform();

// Arch
let arch: string = os.arch();

// Platform dependant variables
let toolsfoldername = ".zephyrtools";
let python = "python3";
let pathdivider = ":";
let which = "which";

switch (platform) {
  case "win32":
    python = "python";
    pathdivider = ";";
    which = "where";
    break;
  default:
    break;
}

// Important directories
let toolsdir = path.join(os.homedir(), toolsfoldername);

// Project specific configuration
export interface ProjectConfig {
  name?: string;
  board?: string;
  boardRootDir?: string;
  target?: string;
  isInit: boolean;
  path: string;
  runner?: string;
  runnerParams?: string;
}

type ProjectConfigDictionary = { [Name: string]: ProjectConfig };

// Config for the extension
export interface GlobalConfig {
  isSetup: boolean;
  env: { [name: string]: string | undefined };
  platformName: string | undefined;
  platformArch: string | undefined;
  toolchains: ToolChainPath;
}

// Config for the extension
export interface WorkspaceConfig {
  env: { [name: string]: string | undefined };
  selectedToolchain: string | undefined;
  projects: ProjectConfigDictionary;
  selectedProject: string | undefined;
  automaticProjectSelction: boolean;
}

// Pending Task
interface ZephyrTask {
  name?: string;
  data?: any;
}

// Output Channel
let output: vscode.OutputChannel;

// Configuration
let config: GlobalConfig;
let wsConfig: WorkspaceConfig;

let statusBar: vscode.StatusBarItem;
let activeProjectView = new ProjectStatusView("", "", "", "");

export function getShellEnvironment() {
  let envPath = process.env;
  if (config.env["PATH"]) {
    envPath["PATH"] = path.join(config.env["PATH"], pathdivider + envPath["PATH"]);
  }
  if (config.env["VIRUTAL_ENV"]) {
    envPath["VIRUTAL_ENV"] = config.env["VIRUTAL_ENV"];
  }
  if (wsConfig.env["PATH"]) {
    envPath["PATH"] = path.join(wsConfig.env["PATH"], pathdivider + envPath["PATH"]);
  }
  if (wsConfig.selectedToolchain !== undefined) {
    envPath["ZEPHYR_SDK_INSTALL_DIR"] = config.toolchains[wsConfig.selectedToolchain];
  }
  return envPath;
}

// this method is called when your extension is first activated on vscode startup
export async function activate(context: vscode.ExtensionContext) {
  // Init task manager
  TaskManager.init();

  // Get the configuration
  config = context.globalState.get("zephyr.env") ?? {
    env: process.env,
    isSetup: false,
    platformName: undefined,
    platformArch: undefined,
    toolchains: {},
  };


  wsConfig = context.workspaceState.get("zephyr.env") ??
  {
    env: {},
    selectedToolchain: undefined,
    projects: {},
    selectedProject: undefined,
    automaticProjectSelction: true,
  };

  context.subscriptions.push(vscode.commands.registerCommand("zephyr-tools.update-status", () => {
    if (wsConfig.selectedProject) {
      statusBar.text = `$(megaphone) ${wsConfig.selectedProject}`;
      vscode.window.showInformationMessage(`Zephyr Tools:\r\n 
      Active Project: ${wsConfig.selectedProject}\r\n
      Active Board: ${wsConfig.projects[wsConfig.selectedProject].board}\r\n
      Board Directory ${wsConfig.projects[wsConfig.selectedProject].boardRootDir} `);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand(
    'zephyr-tools.hello',
    async () => {
      vscode.window.showInformationMessage('Hello world From Zephyr Tools!');
    }
  ));

  const provider = new ActiveProjectPanel(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("zephyrToolsActiveProject", provider));


  const provider2 = new ColorsViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("zephyrToolsStatus", provider2));


  updateActiveProjectView();
  vscode.window.createTreeView('zephyrToolsActiveProjectStatus', {
    treeDataProvider: activeProjectView
  });


  // create a new status bar item that we can now manage
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "zephyr-tools.update-status";
  statusBar.text = `$(megaphone) ${wsConfig.selectedProject}`;
  statusBar.tooltip = "Zephyr Tools Status";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("zephyr-tools.helloWorld", () => {
    HelloWorldPanel.render(context.extensionUri);
  }));


  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(handleChange => {
    if (wsConfig.automaticProjectSelction && handleChange) {
      let filePath = handleChange.document.uri.fsPath;

      for (let key in wsConfig.projects) {
        if (filePath.includes(wsConfig.projects[key].path)) {
          vscode.window.showInformationMessage(`Active project changed to ${key}`);
          wsConfig.selectedProject = key;
          statusBar.text = `$(megaphone) ${wsConfig.selectedProject}`;
          updateActiveProjectView();
        }
      }
    }
  }));


  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.disable-automatic-project-target", async (dest: vscode.Uri | undefined) => {
      wsConfig.automaticProjectSelction = false;
      context.workspaceState.update("zephyr.env", wsConfig);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.enable-automatic-project-target", async (dest: vscode.Uri | undefined) => {
      wsConfig.automaticProjectSelction = true;
      context.workspaceState.update("zephyr.env", wsConfig);
    })
  );

  // Create new
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.create-project", async (dest: vscode.Uri | undefined) => {
      await commands.create_new(context, config, dest);
    })
  );

  // Extension Reset
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.extension-reset", async (dest: vscode.Uri | undefined) => {
      await commands.create_new(context, config, dest);
      context.globalState.update("zephyr.task", undefined);
      context.globalState.update("zephyr.env", undefined);
      context.workspaceState.update("zephyr.env", undefined);
    })
  );

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.setup", async () => {
      config.isSetup = false;
      config.env = {};

      // Show setup progress..
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Setting up Zephyr Environment",
          cancellable: false,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            TaskManager.cancel();
            console.log("User canceled the long running operation");
          });

          // Create & clear output
          if (output === undefined) {
            output = vscode.window.createOutputChannel("Zephyr Tools");
          }

          // Clear output before beginning
          output.clear();
          output.show();

          output.appendLine(
            "Zephyr Tools will now setup the build environment. Please ensure build tools are already installed and available in system path."
          );

          output.appendLine(
            "Please follow the section Install Dependencies. https://docs.zephyrproject.org/latest/develop/getting_started/index.html#install-dependencies."
          );

          output.appendLine(
            "The remaining sections on that page will automatically be handled by the zephyr tools extension"
          );

          output.appendLine(
            "For Windows you may use Chocolately, for debian you may use apt, and for macOS you may use Homebrew"
          );

          // check if directory in $HOME exists
          let exists = await fs.pathExists(toolsdir);
          if (!exists) {
            console.log("toolsdir not found");
            // Otherwise create home directory
            await fs.mkdirp(toolsdir);
          }

          // Promisified exec
          let exec = util.promisify(cp.exec);

          progress.report({ increment: 5 });

          progress.report({ increment: 10 });

          // Check if Git exists in path
          let res = await exec("git --version", {
            env: getShellEnvironment(),
          }).then(
            value => {
              output.append(value.stdout);
              output.append(value.stderr);
              output.appendLine("[SETUP] git installed");
              return true;
            },
            reason => {
              output.appendLine("[SETUP] git is not found");
              output.append(reason);

              switch (platform) {
                case "darwin":
                  output.appendLine("[SETUP] use `brew` to install `git`");
                  output.appendLine("[SETUP] Install `brew` first: https://brew.sh");
                  output.appendLine("[SETUP] Then run `brew install git`");
                  break;
                case "linux":
                  output.appendLine("[SETUP] refer to your distros preferred `git` install method.");
                  break;
                default:
                  break;
              }

              // Error message
              vscode.window.showErrorMessage("Unable to continue. Git not installed. Check output for more info.");
              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          progress.report({ increment: 5 });

          // Otherwise, check Python install
          let cmd = `${python} --version`;
          output.appendLine(cmd);
          res = await exec(cmd, { env: getShellEnvironment() }).then(
            value => {
              if (value.stdout.includes("Python 3")) {
                output.appendLine("[SETUP] python3 found");
              } else {
                output.appendLine("[SETUP] python3 not found");

                switch (platform) {
                  case "darwin":
                    output.appendLine("[SETUP] use `brew` to install `python3`");
                    output.appendLine("[SETUP] Install `brew` first: https://brew.sh");
                    output.appendLine("[SETUP] Then run `brew install python3`");
                    break;
                  case "linux":
                    output.appendLine(
                      "[SETUP] install `python` using `apt get install python3.10 python3.10-pip python3.10-venv`"
                    );
                    break;
                  default:
                    break;
                }

                vscode.window.showErrorMessage("Error finding python. Check output for more info.");
                return false;
              }

              return true;
            },
            reason => {
              output.append(reason.stderr);
              console.error(reason);

              // Error message
              switch (platform) {
                case "darwin":
                  output.appendLine("[SETUP] use `brew` to install `python3`");
                  output.appendLine("[SETUP] Install `brew` first: https://brew.sh");
                  output.appendLine("[SETUP] Then run `brew install python3`");
                  break;
                case "linux":
                  output.appendLine(
                    "[SETUP] install `python` using `apt get install python3.10 python3.10-pip python3.10-venv`"
                  );
                  break;
                default:
                  break;
              }
              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          progress.report({ increment: 5 });

          // Check for `pip`
          cmd = `${python} -m pip --version`;
          output.appendLine(cmd);
          res = await exec(cmd, { env: getShellEnvironment() }).then(
            value => {
              output.append(value.stdout);
              output.append(value.stderr);
              output.appendLine("[SETUP] pip installed");
              return true;
            },
            reason => {
              output.append(reason.stderr);
              console.error(reason);

              // Error message

              // Error message
              switch (platform) {
                case "linux":
                  output.appendLine("[SETUP] please install `python3.10-pip` package (or newer)");
                  break;
                default:
                  output.appendLine("[SETUP] please install `python3` with `pip` support");
                  break;
              }
              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          progress.report({ increment: 5 });

          // create virtualenv within `$HOME/.zephyrtools`
          let pythonenv = path.join(toolsdir, "env");

          // Check if venv is available
          cmd = `${python} -m venv --help`;
          output.appendLine(cmd);
          res = await exec(cmd, { env: getShellEnvironment() }).then(
            value => {
              output.appendLine("[SETUP] python3 venv OK");
              return true;
            },
            reason => {
              output.append(reason.stderr);
              console.error(reason);

              // Error message
              switch (platform) {
                case "linux":
                  output.appendLine("[SETUP] please install `python3.10-venv` package (or newer)");
                  break;
                default:
                  output.appendLine("[SETUP] please install `python3` with `venv` support");
                  break;
              }

              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          // Then create the virtualenv
          cmd = `${python} -m venv "${pythonenv}"`;
          output.appendLine(cmd);
          res = await exec(cmd, { env: getShellEnvironment() }).then(
            value => {
              output.append(value.stdout);
              output.appendLine("[SETUP] virtual python environment created");
              return true;
            },
            reason => {
              output.appendLine("[SETUP] unable to setup virtualenv");
              console.error(reason);

              // Error message
              vscode.window.showErrorMessage("Error installing virtualenv. Check output for more info.");
              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          // Report progress
          progress.report({ increment: 5 });

          // Set VIRTUAL_ENV path otherwise we get terribly annoying errors setting up
          config.env["VIRTUAL_ENV"] = pythonenv;

          // Add env/bin to path
          config.env["PATH"] = path.join(pythonenv, `Scripts${pathdivider}` + config.env["PATH"]);
          config.env["PATH"] = path.join(pythonenv, `bin${pathdivider}` + config.env["PATH"]);

          // Install `west`
          res = await exec(`${python} -m pip install west`, {
            env: getShellEnvironment(),
          }).then(
            value => {
              output.append(value.stdout);
              output.append(value.stderr);
              output.appendLine("[SETUP] west installed");
              return true;
            },
            reason => {
              output.appendLine("[SETUP] unable to install west");
              output.append(JSON.stringify(reason));

              // Error message
              vscode.window.showErrorMessage("Error installing west. Check output for more info.");
              return false;
            }
          );

          // Return if error
          if (!res) {
            return;
          }

          output.appendLine("[SETUP] Zephyr setup complete!");;

          // Setup flag complete
          config.isSetup = true;

          // Save this informaiton to disk
          context.globalState.update("zephyr.env", config);

          // TODO: Then set the application environment to match
          //if (config.env["PATH"] !== undefined && config.env["PATH"] !== "") {
          //  context.environmentVariableCollection.replace("PATH", config.env["PATH"]);
          //}

          progress.report({ increment: 100 });

          vscode.window.showInformationMessage(`Zephyr Tools setup complete!`);
        }
      );
    })
  );


  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.install-sdk", async () => {

      // Show setup progress..
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Setting up Zephyr sdk",
          cancellable: false,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            TaskManager.cancel();
            console.log("User canceled the long running operation");
          });

          // Create & clear output
          if (output === undefined) {
            output = vscode.window.createOutputChannel("Zephyr Tools");
          }

          // Clear output before beginning
          output.clear();
          output.show();

          progress.report({ increment: 5 });

          // Determine what sdk/toolchain to download
          switch (platform) {
            case "darwin":
              config.platformName = "macos";
              break;
            case "linux":
              config.platformName = "linux";
              break;
            case "win32":
              config.platformName = "windows";
              break;
          }
          switch (arch) {
            case "x64":
              config.platformArch = "x86_64";
              break;
            case "arm64":
              config.platformArch = "aarch64";
              break;
          }

          // Skip out if not found
          if (config.platformName === undefined) {
            vscode.window.showErrorMessage("Unsupported platform for Zephyr Tools!");
            return;
          }

          // Pick options
          const pickOptions: vscode.QuickPickOptions = {
            ignoreFocusOut: true,
            placeHolder: "Which toolchain version would you like to install?",
          };

          let toolchainVersionList: string[] = [];
          let toolchainMd5Path = context.asAbsolutePath("manifest/sdk_md5");
          let toolchainMd5Files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(toolchainMd5Path));
          for (const [index, [filename, type]] of toolchainMd5Files.entries()) {
            if (path.parse(filename).ext === ".sum") {
              toolchainVersionList.push(path.parse(filename).name);
            }
          }

          // Prompt user
          let toolchainSelection = await vscode.window.showQuickPick(toolchainVersionList, pickOptions);

          // Check if user canceled
          if (toolchainSelection === undefined) {
            // Show error
            vscode.window.showErrorMessage("Zephyr Tools Setup canceled.");
            return;
          }

          let selectedToolchainFile = context.asAbsolutePath("manifest/sdk_md5/" + toolchainSelection + ".sum");


          // Set up downloader path
          FileDownload.init(path.join(toolsdir, "downloads"));

          let toolchainFileRawText = fs.readFileSync(selectedToolchainFile, 'utf8');
          let toolchainMinimalDownloadEntry: DownloadEntry | undefined;
          let toolchainArmDownloadEntry: DownloadEntry | undefined;

          let toolchainBasePath = "toolchains/zephyr-sdk-" + toolchainSelection;
          for (const line of toolchainFileRawText.trim().split('\n')) {
            let s = line.trim().split(/[\s\s]+/g);
            let md5 = s[0];
            let fileName = s[1];
            let parsedFileName = path.parse(fileName)
            if (parsedFileName.ext === ".xz") {
              parsedFileName = path.parse(parsedFileName.name)
            }

            if (parsedFileName.name === "zephyr-sdk-" + toolchainSelection + "_" + config.platformName + "-" + config.platformArch + "_minimal") {
              toolchainMinimalDownloadEntry = {
                "name": "toolchains/",
                "filename": fileName,
                "url": "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v" + toolchainSelection + "/" + fileName,
                "md5": md5,
                "clearTarget": true,
              };
              if (config.platformName === "macos") {
                toolchainMinimalDownloadEntry.cmd = [{
                  "cmd": "zephyr-sdk-" + toolchainSelection + "/setup.sh -t arm-zephyr-eabi",
                  "usepath": true
                }];
              }
            } else if (parsedFileName.name === "toolchain_" + config.platformName + "-" + config.platformArch + "_arm-zephyr-eabi") {
              toolchainArmDownloadEntry = {
                "name": toolchainBasePath,
                "filename": fileName,
                "url": "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v" + toolchainSelection + "/" + fileName,
                "md5": md5,
                "clearTarget": false,
              };
            }
          }


          if (toolchainArmDownloadEntry === undefined || toolchainMinimalDownloadEntry === undefined) {
            vscode.window.showErrorMessage("Error finding appropriate toolchain file");
            return;
          }

          // Output indicating toolchain install
          output.appendLine(`[SETUP] Installing zephyr-sdk-${toolchainSelection} toolchain...`);

          // Download minimal sdk file
          let res: boolean = await processDownload(toolchainMinimalDownloadEntry);
          if (!res) {
            vscode.window.showErrorMessage("Error downloading minimal toolchain file. Check output for more info.");
            return;
          }
          progress.report({ increment: 5 });

          // Download arm sdk file
          res = await processDownload(toolchainArmDownloadEntry);
          if (!res) {
            vscode.window.showErrorMessage("Error downloading arm toolchain file. Check output for more info.");
            return;
          }
          progress.report({ increment: 10 });

          // Setup flag complete
          config.toolchains[toolchainSelection] = path.join(toolsdir, toolchainBasePath);

          // Save this informaiton to disk
          context.globalState.update("zephyr.env", config);

          setSdk(toolchainSelection, context);

          progress.report({ increment: 100 });
          output.appendLine(`[SETUP] Installing zephyr-sdk-${toolchainSelection} complete`);

          vscode.window.showInformationMessage(`Zephyr Tools setup complete!`);
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.set-sdk", async () => {
      const pickOptions: vscode.QuickPickOptions = {
        ignoreFocusOut: true,
        placeHolder: "Which toolchain version would you like to set?",
      };

      let toolchainVersionList: string[] = [];
      for (let key in config.toolchains) {
        toolchainVersionList.push(key);
      }
      // Prompt user
      let toolchainSelection = await vscode.window.showQuickPick(toolchainVersionList, pickOptions);
      if (toolchainSelection === undefined) {
        return;
      }

      setSdk(toolchainSelection, context);


      vscode.window.showInformationMessage(`Set Zephry SDK to: ` + toolchainSelection);
    }));

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.init-repo", async (_dest: vscode.Uri | undefined) => {
      // Get destination
      let dest = await helper.get_dest(_dest);

      // See if config is set first
      if (config.isSetup && dest !== null) {
        initRepo(config, context, dest);
      } else {
        vscode.window.showErrorMessage("Run `Zephyr Tools: Setup` command first.");
        return;
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.add-project", async () => {
      // See if config is set first
      if (config.isSetup) {
        addProject(config, context);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command first.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.set-project", async () => {
      // See if config is set first
      if (config.isSetup && Object.keys(wsConfig.projects).length) {
        setProject(config, context);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command first.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.change-board", async () => {
      // See if config is set first
      if (config.isSetup) {
        changeBoard(config, context);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command first.");
      }
    })
  );

  // Does a pristine zephyr build
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.build-pristine", async () => {
      if (config.isSetup) {
        if (wsConfig.selectedProject === undefined) {
          vscode.window.showErrorMessage("Select a project before trying to clean");
          return;
        }
        if (!wsConfig.projects[wsConfig.selectedProject].isInit) {
          vscode.window.showErrorMessage("Run `Zephyr Tools: Init Repo` command first.");
          return;
        }
        let activeProject = wsConfig.projects[wsConfig.selectedProject];
        await build(config, activeProject, true, context);
      } else {
        vscode.window.showErrorMessage("Run `Zephyr Tools: Setup` command first.");
      }
    })
  );

  // Utilizes build cache (if it exists) and builds
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.build", async () => {
      if (config.isSetup) {
        if (wsConfig.selectedProject === undefined) {
          vscode.window.showErrorMessage("Select a project before trying to clean");
          return;
        }
        if (!wsConfig.projects[wsConfig.selectedProject].isInit) {
          vscode.window.showErrorMessage("Run `Zephyr Tools: Init Repo` command first.");
          return;
        }
        let activeProject = wsConfig.projects[wsConfig.selectedProject];

        await build(config, activeProject, false, context);
      } else {
        vscode.window.showErrorMessage("Run `Zephyr Tools: Setup` command first.");
      }
    })
  );

  // Flashes Zephyr project to board
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.flash", async () => {
      if (config.isSetup) {
        if (wsConfig.selectedProject === undefined) {
          vscode.window.showErrorMessage("Select a project before trying to clean");
          return;
        }


        let activeProject = wsConfig.projects[wsConfig.selectedProject];

        await flash(config, activeProject);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command before flashing.");
      }
    })
  );

  // Cleans the project by removing the `build` folder
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.clean", async () => {
      // Flash board
      if (config.isSetup) {
        if (wsConfig.selectedProject === undefined) {
          vscode.window.showErrorMessage("Select a project before trying to clean");
          return;
        }

        let activeProject = wsConfig.projects[wsConfig.selectedProject];

        await clean(config, activeProject);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Tools: Setup` command before flashing.");
      }
    })
  );

  // Update dependencies
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.update", async () => {
      if (config.isSetup) {
        if (wsConfig.selectedProject === undefined) {
          vscode.window.showErrorMessage("Select a project before trying to clean");
          return;
        }

        let activeProject = wsConfig.projects[wsConfig.selectedProject];

        await update(config, activeProject);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command before flashing.");
      }
    })
  );


  // Command for changing runner and params
  context.subscriptions.push(
    vscode.commands.registerCommand("zephyr-tools.change-runner", async () => {
      // See if config is set first
      if (config.isSetup) {
        changeRunner(config, context);
      } else {
        // Display an error message box to the user
        vscode.window.showErrorMessage("Run `Zephyr Toools: Setup` command first.");
      }
    })
  );

  context.subscriptions.push(vscode.window.registerTerminalProfileProvider('zephyr-tools.terminal-profile', {
    provideTerminalProfile(token: vscode.CancellationToken): vscode.ProviderResult<vscode.TerminalProfile> {
      let opts: vscode.TerminalOptions = {
        name: "Zephyr Tools Terminal",
        env: getShellEnvironment(),
      };
      return new vscode.TerminalProfile(opts);
    }
  }));

  // Check if there's a task to run
  let task: ZephyrTask | undefined = context.globalState.get("zephyr.task");
  if (task !== undefined && task.name !== undefined) {
    console.log("Run task! " + JSON.stringify(task));

    context.globalState.update("zephyr.task", undefined);
    await vscode.commands.executeCommand(task.name, task.data);
  }
}

export async function initRepo(config: GlobalConfig, context: vscode.ExtensionContext, dest: vscode.Uri) {
  // Create output
  if (output === undefined) {
    output = vscode.window.createOutputChannel("Zephyr Tools");
  }
  output.show();

  try {
    // Tasks
    let taskName = "Zephyr Tools: Init Repo";

    // Pick options
    const pickOptions: vscode.QuickPickOptions = {
      ignoreFocusOut: true,
      placeHolder: "Where would you like to initialize from?",
    };

    // Get the root path of the workspace
    let rootPath = getRootPath();

    // Check if we're in the right workspace
    if (rootPath?.fsPath !== dest.fsPath) {
      console.log("Setting task!");

      // Set init-repo task next
      let task: ZephyrTask = { name: "zephyr-tools.init-repo", data: dest };
      context.globalState.update("zephyr.task", task);

      // Change workspace
      await vscode.commands.executeCommand("vscode.openFolder", dest);
    }

    // Set .vscode/settings.json
    // Temporarily of course..
    let settings = {
      "git.enabled": false,
      "git.path": null,
      "git.autofetch": false,
    };

    // Make .vscode dir and settings.json
    await fs.mkdirp(path.join(dest.fsPath, ".vscode"));
    await fs.writeFile(path.join(dest.fsPath, ".vscode", "settings.json"), JSON.stringify(settings));

    // Options for Shell execution options
    let shellOptions: vscode.ShellExecutionOptions = {
      env: <{ [key: string]: string }>config.env,
      cwd: dest.fsPath,
    };

    // Check if .git is already here.
    let exists = await fs.pathExists(path.join(dest.fsPath, ".west"));

    if (!exists) {
      // Options for input box
      const inputOptions: vscode.InputBoxOptions = {
        prompt: "Enter git repository URL.",
        placeHolder: "<Enter your git repository address here>",
        ignoreFocusOut: true,
        validateInput: text => {
          return text !== undefined && text !== "" ? null : "Enter a valid git repository address.";
        },
      };

      // Prompt for URL to init..
      let url = await vscode.window.showInputBox(inputOptions);
      if (url === undefined) {
        vscode.window.showErrorMessage(`Zephyr Tools: invalid repository url provided.`);
        return;
      }

      // Ask for branch
      const branchInputOptions: vscode.InputBoxOptions = {
        prompt: "Enter branch name.",
        placeHolder: "Press enter for default",
        ignoreFocusOut: true,
      };

      let branch = await vscode.window.showInputBox(branchInputOptions);

      // TODO: determine choices for west.yml
      let manifest = "west.yml";

      // git clone to destination
      let cmd = `west init -m ${url} --mf ${manifest}`;

      // Set branch option
      if (branch !== undefined && branch !== "") {
        console.log(`Branch '${branch}'`);

        cmd = cmd + ` --mr ${branch}`;
      }

      let exec = new vscode.ShellExecution(cmd, shellOptions);

      // Task
      let task = new vscode.Task(
        { type: "zephyr-tools", command: taskName },
        vscode.TaskScope.Workspace,
        taskName,
        "zephyr-tools",
        exec
      );

      // Start execution
      await TaskManager.push(task, { ignoreError: true, lastTask: false });
    }

    // `west update`
    let cmd = `west update`;
    let exec = new vscode.ShellExecution(cmd, shellOptions);

    // Task
    let task = new vscode.Task(
      { type: "zephyr-tools", command: taskName },
      vscode.TaskScope.Workspace,
      taskName,
      "zephyr-tools",
      exec
    );

    // Start execution
    await TaskManager.push(task, { ignoreError: false, lastTask: false });

    // Generic callback
    let done = async (data: any) => {
      // Set the isInit flag
      let project: ProjectConfig = context.workspaceState.get("zephyr.project") ?? { isInit: false, path: "" };
      project.isInit = true;
      await context.workspaceState.update("zephyr.project", project);
    };

    // Get zephyr BASE
    let base = "zephyr";

    {
      let exec = util.promisify(cp.exec);

      // Get listofports
      let cmd = `west list -f {path:28} zephyr`;
      let res = await exec(cmd, { env: getShellEnvironment(), cwd: dest.fsPath });
      if (res.stderr) {
        output.append(res.stderr);
        output.show();
      } else {
        res.stdout.split("\n").forEach((line: string) => {
          if (line.includes("zephyr")) {
            base = line.trim();
          }
        });
      }
    }

    // Install python dependencies `pip install -r zephyr/requirements.txt`
    cmd = `pip install -r ${path.join(base, "scripts", "requirements.txt")}`;
    exec = new vscode.ShellExecution(cmd, shellOptions);

    // Task
    task = new vscode.Task(
      { type: "zephyr-tools", command: taskName },
      vscode.TaskScope.Workspace,
      taskName,
      "zephyr-tools",
      exec
    );

    // Start execution
    await TaskManager.push(task, {
      ignoreError: false,
      lastTask: true,
      successMessage: "Init complete!",
      callback: done,
      callbackData: { dest: dest },
    });
  } catch (error) {
    let text = "";
    if (typeof error === "string") {
      text = error;
    } else if (error instanceof Error) {
      text = error.message;
    }

    output.append(text);
    vscode.window.showErrorMessage(`Zephyr Tools: Init Repo error. See output for details.`);
  }
}

// TODO: select programmer ID if there are multiple..
async function flash(config: GlobalConfig, project: ProjectConfig) {
  // Options for SehllExecution
  let options: vscode.ShellExecutionOptions = {
    env: <{ [key: string]: string }>getShellEnvironment(),
    cwd: project.target,
  };

  // Tasks
  let taskName = "Zephyr Tools: Flash";
  let cmd = `west flash`;

  // Add runner if it exists
  if (project.runner) {
    cmd += ` -r ${project.runner} ${project.runnerParams ?? ""}`;
  }

  console.log("command: " + cmd);

  let exec = new vscode.ShellExecution(cmd, options);

  // Task
  let task = new vscode.Task(
    { type: "zephyr-tools", command: taskName, isBackground: true },
    vscode.TaskScope.Workspace,
    taskName,
    "zephyr-tools",
    exec
  );

  vscode.window.showInformationMessage(`Flashing for ${project.board}`);

  // Start task here
  await vscode.tasks.executeTask(task);
}

function getRootPath(): vscode.Uri | undefined {
  // Get the workspace root
  let rootPath = undefined;
  if (vscode.workspace.workspaceFolders?.length ?? 0 > 0) {
    rootPath = vscode.workspace.workspaceFolders?.[0].uri;
  } else {
    rootPath = undefined;
  }

  return rootPath;
}

async function getBoardlist(folder: vscode.Uri): Promise<string[]> {
  let files = await vscode.workspace.fs.readDirectory(folder);
  let boards: string[] = [];

  while (true) {
    let file = files.pop();

    // Stop looping once done.
    if (file === undefined) {
      break;
    }

    if (file[0].includes(".yaml")) {
      let parsed = path.parse(file[0]);
      boards.push(parsed.name);
    } else if (file[0].includes("build") || file[0].includes(".git")) {
      // Don't do anything
    } else if (file[1] === vscode.FileType.Directory) {
      let path = vscode.Uri.joinPath(folder, file[0]);
      let subfolders = await vscode.workspace.fs.readDirectory(path);

      for (let { index, value } of subfolders.map((value, index) => ({
        index,
        value,
      }))) {
        subfolders[index][0] = vscode.Uri.parse(`${file[0]}/${subfolders[index][0]}`).fsPath;
        console.log(subfolders[index][0]);
      }

      files = files.concat(subfolders);
    }
  }

  return boards;
}
async function setProject(config: GlobalConfig, context: vscode.ExtensionContext) {
  const pickOptions: vscode.QuickPickOptions = {
    ignoreFocusOut: true,
    placeHolder: "Select Project",
  };

  let projectList: string[] = [];
  for (let key in wsConfig.projects) {
    projectList.push(key);
  }
  // Prompt user
  let selectedProject = await vscode.window.showQuickPick(projectList, pickOptions);
  if (selectedProject === undefined) {
    return;
  }
  wsConfig.selectedProject = selectedProject;
  await context.workspaceState.update("zephyr.env", wsConfig);
  vscode.window.showInformationMessage(`Successfully Set ${selectedProject} as Active Project`);
}

async function updateActiveProjectView() {
  if (wsConfig.selectedProject) {
    activeProjectView.activeProject = wsConfig.selectedProject;
    activeProjectView.activeBoard = wsConfig.projects[wsConfig.selectedProject].board;
    activeProjectView.activeBoardDir = wsConfig.projects[wsConfig.selectedProject].boardRootDir;
    activeProjectView.selectedToolchain = wsConfig.selectedToolchain;
    activeProjectView.refresh();
  }
}

async function addProject(config: GlobalConfig, context: vscode.ExtensionContext) {
  // Create & clear output
  if (output === undefined) {
    output = vscode.window.createOutputChannel("Zephyr Tools");
  }

  const dialogOptions: vscode.OpenDialogOptions = {
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: "Select project folder."
  };

  // Open file picker for destination directory
  let open = await vscode.window.showOpenDialog(dialogOptions);
  if (open === undefined) {
    vscode.window.showErrorMessage('Failed to provide a valid target folder.');
    return null;
  }

  let projectPath = open[0].fsPath;
  let projectCmakePath = projectPath + "/CMakeLists.txt";

  // Find all CMakeLists.txt files with `project(` in them
  if (fs.pathExistsSync(projectCmakePath)) {
    let contents = await vscode.workspace.openTextDocument(projectCmakePath).then(document => {
      return document.getText();
    });

    if (contents.includes("project(")) {
      let projectName = path.parse(projectPath).name;
      wsConfig.projects[projectName] = {
        isInit: true,
        path: projectPath,
        target: projectPath,
        name: projectName,
      };
      wsConfig.selectedProject = projectName;
      await context.workspaceState.update("zephyr.env", wsConfig);
    } else {
      vscode.window.showInformationMessage(`Failed to Load Project ${projectPath}, Does your project folder have a correct CMake File?`)
      return;
    }
  } else {
    vscode.window.showInformationMessage(`Failed to Load Project ${projectPath}, Does your project folder have a CMakeLists.txt File?`)
    return;
  }
  vscode.window.showInformationMessage(`Successfully loaded Project ${projectPath}`);
}

async function changeBoard(config: GlobalConfig, context: vscode.ExtensionContext) {
  // Get the workspace root
  if (wsConfig.selectedProject === undefined) {
    vscode.window.showInformationMessage(`Failed to change board, please first select a project`);
    return;
  }
  let rootPath;
  let rootPaths = vscode.workspace.workspaceFolders;
  if (rootPaths === undefined) {
    return;
  } else {
    rootPath = rootPaths[0].uri;
  }

  console.log("Roto path: " + rootPath.fsPath);
  let files = await vscode.workspace.fs.readDirectory(rootPath);

  // Looks for board directories
  let boardDirectories: string[] = [];

  // Look in root
  let boardDir = vscode.Uri.joinPath(rootPath, `boards`);
  if (fs.pathExistsSync(boardDir.fsPath)) {
    boardDirectories = boardDirectories.concat(boardDir.fsPath);
  }

  // Look in folders in root and Zephyr folder
  for (const [index, [file, type]] of files.entries()) {
    if (type === vscode.FileType.Directory) {
      let boardDir = vscode.Uri.joinPath(rootPath, `${file}/boards`);
      if (fs.pathExistsSync(boardDir.fsPath)) {
        boardDirectories = boardDirectories.concat(boardDir.fsPath);
      }

      let zephyrBoardDir = vscode.Uri.joinPath(rootPath, `${file}/zephyr/boards`);
      if (fs.pathExistsSync(zephyrBoardDir.fsPath)) {
        boardDirectories = boardDirectories.concat(zephyrBoardDir.fsPath);
      }
    }
  }
  console.log("Boards dir: " + boardDirectories);

  // Prompt which board directory to use
  const boardDirResult = await vscode.window.showQuickPick(boardDirectories, {
    placeHolder: "Pick your board directory..",
    ignoreFocusOut: true,
  });

  let boards: string[] = [];

  if (boardDirResult) {
    console.log("Changing board dir to " + boardDirResult);
    boards = boards.concat(await getBoardlist(vscode.Uri.file(boardDirResult)));
    // Prompt which board to use
    const result = await vscode.window.showQuickPick(boards, {
      placeHolder: "Pick your board..",
      ignoreFocusOut: true,
    });

    if (result) {
      console.log("Changing board to " + result);
      vscode.window.showInformationMessage(`Board changed to ${result}`);
      wsConfig.projects[wsConfig.selectedProject].boardRootDir = path.parse(boardDirResult).dir;
      wsConfig.projects[wsConfig.selectedProject].board = result;
      await context.workspaceState.update("zephyr.env", wsConfig);
    }
  }
}

async function changeRunner(config: GlobalConfig, context: vscode.ExtensionContext) {
  // Get the workspace root
  if (wsConfig.selectedProject === undefined) {
    vscode.window.showInformationMessage(`Failed to change board, please first select a project`);
    return;
  }

  let rootPath;
  let rootPaths = vscode.workspace.workspaceFolders;
  if (rootPaths === undefined) {
    return;
  } else {
    rootPath = rootPaths[0].uri;
  }

  console.log("Roto path: " + rootPath.fsPath);

  // Get runners
  let runners: string[] = ["default", "jlink", "nrfjprog", "openocd", "pyocd", "qemu", "stlink"];
  let args = "";

  // Prompt which board to use
  const result = await vscode.window.showQuickPick(runners, {
    placeHolder: "Pick your runner..",
    ignoreFocusOut: true,
  });

  let argsResult = await vscode.window.showInputBox({
    placeHolder: "Enter runner args..",
    ignoreFocusOut: true,
  });

  if (result) {
    // Check to make sure args are not undefined
    if (argsResult) {
      args = " with args: " + argsResult;

      // Set runner args
      wsConfig.projects[wsConfig.selectedProject].runnerParams = argsResult;
    } else {
      wsConfig.projects[wsConfig.selectedProject].runnerParams = undefined;
    }

    console.log("Changing runner to " + result + args);
    vscode.window.showInformationMessage(`Runner changed to ${result}${args}`);

    if (result === "default") {
      wsConfig.projects[wsConfig.selectedProject].runner = undefined;
    } else {
      wsConfig.projects[wsConfig.selectedProject].runner = result;
    }
    await context.workspaceState.update("zephyr.env", wsConfig);
  }
}

export async function update(config: GlobalConfig, project: ProjectConfig) {
  // Get the active workspace root path
  let rootPath;
  let rootPaths = vscode.workspace.workspaceFolders;
  if (rootPaths === undefined) {
    return;
  } else {
    rootPath = rootPaths[0].uri;
  }

  // Options for Shell Execution
  let options: vscode.ShellExecutionOptions = {
    env: <{ [key: string]: string }>getShellEnvironment(),
    cwd: rootPath.fsPath,
  };

  // Tasks
  let taskName = "Zephyr Tools: Update Dependencies";

  // Enable python env
  let cmd = `west update`;
  let exec = new vscode.ShellExecution(cmd, options);

  // Task
  let task = new vscode.Task(
    { type: "zephyr-tools", command: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "zephyr-tools",
    exec
  );

  await vscode.tasks.executeTask(task);

  // Get zephyr BASE
  let base = undefined;

  let exec1 = util.promisify(cp.exec);

  // Get listofports
  if (vscode.workspace.workspaceFolders) {
    cmd = `west list -f {path:28} zephyr`;
    let cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
    let res = await exec1(cmd, { env: getShellEnvironment(), cwd: cwd });
    if (res.stderr) {
      output.append(res.stderr);
      output.show();
    } else {
      if (res.stdout.includes("zephyr")) {
        base = res.stdout.trim();
      }
    }
  }


  if (base) {
    // Install python dependencies `pip install -r zephyr/requirements.txt`
    cmd = `pip install -r ${path.join(base, "scripts", "requirements.txt")}`;
    exec = new vscode.ShellExecution(cmd, getShellEnvironment());
  }


  // Task
  task = new vscode.Task(
    { type: "zephyr-tools", command: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "zephyr-tools",
    exec
  );

  await vscode.tasks.executeTask(task);
  vscode.window.showInformationMessage(`Updating dependencies for project.`);
}

async function build(
  config: GlobalConfig,
  project: ProjectConfig,
  pristine: boolean,
  context: vscode.ExtensionContext
) {
  // Return if env is not set
  if (config.env === undefined) {
    console.log("Env is undefined!");
    return;
  }

  // Return if undefined
  if (project.board === undefined) {
    // Change board function
    await changeBoard(config, context);

    // Check again..
    if (project.board === undefined) {
      await vscode.window.showErrorMessage(`You must choose a board to continue.`);
      return;
    }
  }

  if (project.target === undefined) {
    await addProject(config, context);

    // Check again..
    if (project.target === undefined) {
      await vscode.window.showErrorMessage(`You must choose a project to build.`);
      return;
    }
  }

  // Get the active workspace root path
  let rootPath;
  let rootPaths = vscode.workspace.workspaceFolders;
  if (rootPaths === undefined) {
    return;
  } else {
    rootPath = rootPaths[0].uri;
  }

  // Print the environment
  console.log("Env: " + JSON.stringify(getShellEnvironment()));

  // Options for SehllExecution
  let options: vscode.ShellExecutionOptions = {
    env: <{ [key: string]: string }>getShellEnvironment(),
    cwd: project.target,
  };

  // Tasks
  let taskName = "Zephyr Tools: Build";

  // Enable python env
  let cmd = `west build -b ${project.board}${pristine ? " -p" : ""} -- -DBOARD_ROOT='${project.boardRootDir}'  `;
  let exec = new vscode.ShellExecution(cmd, options);

  // Task
  let task = new vscode.Task(
    { type: "zephyr-tools", command: taskName },
    vscode.TaskScope.Workspace,
    taskName,
    "zephyr-tools",
    exec
  );

  vscode.window.showInformationMessage(`Building for ${project.board}`);

  // Start execution
  await vscode.tasks.executeTask(task);
}

async function setSdk(toolchainSelection: string, context: vscode.ExtensionContext) {
  wsConfig.selectedToolchain = toolchainSelection;
  context.workspaceState.update("zephyr.env", wsConfig);
}

async function processDownload(download: DownloadEntry) {
  // Promisified exec
  let exec = util.promisify(cp.exec);

  // Check if it already exists
  let filepath = await FileDownload.exists(download.filename);

  // Download if doesn't exist _or_ hash doesn't match
  if (filepath === null || (await FileDownload.check(download.filename, download.md5)) === false) {
    output.appendLine("[SETUP] downloading " + download.url);
    filepath = await FileDownload.fetch(download.url);

    // Check again
    if ((await FileDownload.check(download.filename, download.md5)) === false) {
      vscode.window.showErrorMessage("Error downloading " + download.filename + ". Checksum mismatch.");
      return false;
    }
  }

  // Get the path to copy the contents to..
  let copytopath = path.join(toolsdir, download.name);

  // Check if copytopath exists and create if not
  if (!(await fs.pathExists(copytopath))) {
    await fs.mkdirp(copytopath);
  }

  // Unpack and place into `$HOME/.zephyrtools`
  if (download.url.includes(".zip")) {
    // Unzip and copy
    output.appendLine(`[SETUP] unzip ${filepath} to ${copytopath}`);
    const zip = new unzip.async({ file: filepath });
    zip.on("extract", (entry, file) => {
      // Make executable
      fs.chmodSync(file, 0o755);
    });
    await zip.extract(null, copytopath);
    await zip.close();
  } else if (download.url.includes("tar")) {
    // Then untar
    const cmd = `tar -xvf "${filepath}" -C "${copytopath}"`;
    output.appendLine(cmd);
    let res = await exec(cmd, { env: getShellEnvironment() }).then(
      value => {
        output.append(value.stdout);
        return true;
      },
      reason => {
        output.append(reason.stdout);
        output.append(reason.stderr);

        // Error message
        vscode.window.showErrorMessage("Error un-tar of download. Check output for more info.");

        return false;
      }
    );

    // Return if untar was unsuccessful
    if (!res) {
      return false;
    }
  } else if (download.url.includes("7z")) {
    // Unzip and copy
    output.appendLine(`[SETUP] 7z extract ${filepath} to ${copytopath}`);

    const pathTo7zip = sevenzip.path7za;
    const seven = node7zip.extractFull(filepath, copytopath, {
      $bin: pathTo7zip,
    });
  }

  // Run any commands that are needed..
  for (let entry of download.cmd ?? []) {
    output.appendLine(entry.cmd);

    // Prepend
    let cmd = entry.cmd;
    if (entry.usepath) {
      cmd = path.join(copytopath, entry.cmd ?? "");
    }

    // Run the command
    let res = await exec(cmd, { env: getShellEnvironment() }).then(
      value => {
        output.append(value.stdout);
        return true;
      },
      reason => {
        output.append(reason.stdout);
        output.append(reason.stderr);

        // Error message
        vscode.window.showErrorMessage("Error for sdk command.");

        return false;
      }
    );

    if (!res) {
      return false;
    }
  }

  return true;
}

async function clean(config: GlobalConfig, project: ProjectConfig) {
  // Get the active workspace root path
  let rootPath;
  let rootPaths = vscode.workspace.workspaceFolders;
  if (rootPaths === undefined) {
    return;
  } else {
    rootPath = rootPaths[0].uri;
  }

  // Return if undefined
  if (rootPath === undefined || project.board === undefined || project.target === undefined) {
    return;
  }

  //Get build folder
  let buildFolder = path.join(project.target.toString(), "build");

  // Remove build folder
  await fs.remove(buildFolder);

  vscode.window.showInformationMessage(`Cleaning ${project.target}`);
}

// this method is called when your extension is deactivated
export function deactivate() { }
