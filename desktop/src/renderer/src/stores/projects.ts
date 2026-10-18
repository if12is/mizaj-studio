import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import type { DocumentFull, DocumentSummary, Project } from '@renderer/api/client'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const documents = ref<Record<number, DocumentSummary[]>>({})
  const currentProjectId = ref<number | null>(null)
  const currentDocument = ref<DocumentFull | null>(null)

  async function loadProjects(): Promise<void> {
    projects.value = await useApi().get<Project[]>('/api/projects')
    for (const p of projects.value) await loadDocuments(p.id)
  }
  async function loadDocuments(projectId: number): Promise<void> {
    documents.value = {
      ...documents.value,
      [projectId]: await useApi().get<DocumentSummary[]>(`/api/documents?project_id=${projectId}`)
    }
  }
  async function createProject(name: string): Promise<Project> {
    const p = await useApi().post<Project>('/api/projects', { name })
    projects.value = [p, ...projects.value]
    documents.value = { ...documents.value, [p.id]: [] }
    currentProjectId.value = p.id
    return p
  }
  async function createDocument(
    projectId: number,
    title: string,
    content = ''
  ): Promise<DocumentFull> {
    const d = await useApi().post<DocumentFull>('/api/documents', {
      project_id: projectId,
      title,
      raw_content: content
    })
    await loadDocuments(projectId)
    return d
  }
  async function renameProject(id: number, name: string): Promise<void> {
    const p = await useApi().put<Project>(`/api/projects/${id}`, { name })
    projects.value = projects.value.map((x) => (x.id === id ? p : x))
  }
  async function deleteProject(id: number): Promise<void> {
    await useApi().del(`/api/projects/${id}`)
    projects.value = projects.value.filter((x) => x.id !== id)
    const rest = { ...documents.value }
    delete rest[id]
    documents.value = rest
    if (currentProjectId.value === id) currentProjectId.value = null
    if (currentDocument.value?.project_id === id) currentDocument.value = null
  }
  async function renameDocument(id: number, title: string): Promise<void> {
    const d = await useApi().put<DocumentFull>(`/api/documents/${id}`, { title })
    const list = documents.value[d.project_id]
    if (list) {
      documents.value = {
        ...documents.value,
        [d.project_id]: list.map((x) => (x.id === id ? { ...x, title: d.title } : x))
      }
    }
    if (currentDocument.value?.id === id) {
      currentDocument.value = { ...currentDocument.value, title: d.title }
    }
  }
  async function deleteDocument(id: number, projectId: number): Promise<void> {
    await useApi().del(`/api/documents/${id}`)
    const list = documents.value[projectId]
    if (list) {
      documents.value = { ...documents.value, [projectId]: list.filter((x) => x.id !== id) }
    }
    if (currentDocument.value?.id === id) currentDocument.value = null
  }
  /** Fetch only; does not change the current document. */
  function fetchDocument(id: number): Promise<DocumentFull> {
    return useApi().get<DocumentFull>(`/api/documents/${id}`)
  }
  function setCurrentDocument(d: DocumentFull): void {
    currentProjectId.value = d.project_id
    currentDocument.value = d
  }
  /** Fetch a document and make it current (caller flushes autosave first). */
  async function selectDocument(id: number): Promise<DocumentFull> {
    const d = await useApi().get<DocumentFull>(`/api/documents/${id}`)
    currentProjectId.value = d.project_id
    currentDocument.value = d
    return d
  }
  async function saveContent(id: number, rawContent: string, diacritized?: boolean): Promise<void> {
    const body: Record<string, string> = { raw_content: rawContent }
    if (diacritized) body.diacritized_content = rawContent
    const d = await useApi().put<DocumentFull>(`/api/documents/${id}`, body, true)
    const list = documents.value[d.project_id]
    if (list) {
      documents.value = {
        ...documents.value,
        [d.project_id]: list.map((x) => (x.id === d.id ? { ...x, word_count: d.word_count } : x))
      }
    }
  }

  return {
    projects,
    documents,
    currentProjectId,
    currentDocument,
    loadProjects,
    loadDocuments,
    renameProject,
    deleteProject,
    renameDocument,
    deleteDocument,
    createProject,
    createDocument,
    selectDocument,
    fetchDocument,
    setCurrentDocument,
    saveContent
  }
})
