import * as vscode from 'vscode';
export class ProjectStatusView implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(public activeProject: string | undefined, public activeBoard: string | undefined, public activeBoardDir: string | undefined, public selectedToolchain: string | undefined) { }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    let item: vscode.TreeItem[] = [];
    item.push({
      label: "Project:",
      description: this.activeProject
    });
    item.push({
      label: "Board:",
      description: this.activeBoard
    });
    item.push({
      label: "Board Dir:",
      description: this.activeBoardDir
    });
    item.push({
      label: "Toolchain:",
      description: this.selectedToolchain
    });

    return Promise.resolve(item);
  }

  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}