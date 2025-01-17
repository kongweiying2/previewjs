package com.previewjs.intellij.plugin.actions

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileEditor.FileEditorManager
import com.previewjs.intellij.plugin.services.ProjectService

class OpenPreviewAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val notificationGroup = NotificationGroupManager.getInstance().getNotificationGroup("Preview.js")
        val project = e.project ?: return
        val manager = FileEditorManager.getInstance(project)
        val selectedFiles = manager.selectedFiles
        val selectedTextEditor = manager.selectedTextEditor
        if (selectedTextEditor == null || selectedFiles.isEmpty()) {
            notificationGroup.createNotification(
                "No file is currently selected",
                NotificationType.ERROR
            ).notify(project)
            return
        }
        val selectedFile = selectedFiles[0]
        val offset = manager.selectedTextEditor?.selectionModel?.selectionStart
        val projectService = project.getService(ProjectService::class.java)
        projectService.computeComponents(selectedFile) { components ->
            if (components.isEmpty()) {
                notificationGroup.createNotification(
                    "No components detected in ${selectedFile.path}",
                    NotificationType.ERROR
                ).notify(project)
                return@computeComponents
            }
            val component =
                components.find { c -> offset != null && offset >= c.start && offset <= c.end } ?: components[0]
            projectService.openPreview(selectedFile.path, component.componentId)
        }
    }

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }
}
