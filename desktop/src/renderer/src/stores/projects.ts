import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import type { DocumentFull, DocumentSummary, Project } from '@renderer/api/client'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const documents = ref<Record<number, DocumentSummary[]>>({})
  const currentProjectId = ref<number | null>(null)
  const currentDocument = ref<DocumentFull | null>(null)

  /**
   * Bumped around every local mutation. A list fetch that was in flight while a mutation
   * happened may carry a stale snapshot (e.g. the startup load resolving after the user created
   * a project), so it is discarded and re-fetched instead of overwriting newer state.
   */
  let epoch = 0
  const touch = (): void => {
    epoch++
  }
  async function loadProjects(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = epoch
      const list = await useApi().get<Project[]>('/api/projects')
      if (seen !== epoch) continue
      projects.value = list
      break
    }
    for (const p of projects.value) await loadDocuments(p.id)
  }
  async function loadDocuments(projectId: number): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = epoch
      const list = await useApi().get<DocumentSummary[]>(`/api/documents?project_id=${projectId}`)
      if (seen !== epoch && attempt < 4) continue
      documents.value = { ...documents.value, [projectId]: list }
      break
    }
  }
  async function createProject(name: string): Promise<Project> {
    touch()
    const p = await useApi().post<Project>('/api/projects', { name })
    touch()
    projects.value = [p, ...projects.value.filter((x) => x.id !== p.id)] // a concurrent list load may already hold it
    documents.value = { ...documents.value, [p.id]: [] }
    currentProjectId.value = p.id
    return p
  }
  async function createDocument(
    projectId: number,
    title: string,
    content = '',
    historyLabel?: string
  ): Promise<DocumentFull> {
    touch()
    const d = await useApi().post<DocumentFull>('/api/documents', {
      project_id: projectId,
      title,
      raw_content: content,
      ...(historyLabel ? { history_label: historyLabel } : {})
    })
    touch()
    await loadDocuments(projectId)
    return d
  }
  async function renameProject(id: number, name: string): Promise<void> {
    touch()
    const p = await useApi().put<Project>(`/api/projects/${id}`, { name })
    touch()
    projects.value = projects.value.map((x) => (x.id === id ? p : x))
  }
  /** Per-project «الياء آخر الكلمة» override; null = follow the global setting. */
  async function setYaStyle(id: number, v: 'standard' | 'egyptian' | null): Promise<void> {
    touch()
    const p = await useApi().put<Project>(`/api/projects/${id}`, { ya_style: v })
    touch()
    projects.value = projects.value.map((x) => (x.id === id ? p : x))
  }
  async function deleteProject(id: number): Promise<void> {
    touch()
    await useApi().del(`/api/projects/${id}`)
    touch()
    projects.value = projects.value.filter((x) => x.id !== id)
    const rest = { ...documents.value }
    delete rest[id]
    documents.value = rest
    if (currentProjectId.value === id) currentProjectId.value = null
    if (currentDocument.value?.project_id === id) currentDocument.value = null
  }
  async function renameDocument(id: number, title: string): Promise<void> {
    touch()
    const d = await useApi().put<DocumentFull>(`/api/documents/${id}`, { title })
    touch()
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
    touch()
    await useApi().del(`/api/documents/${id}`)
    touch()
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
  /** No document is open (an empty tab is active). */
  function clearCurrentDocument(): void {
    currentDocument.value = null
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
    setYaStyle,
    deleteProject,
    renameDocument,
    deleteDocument,
    createProject,
    createDocument,
    selectDocument,
    fetchDocument,
    setCurrentDocument,
    clearCurrentDocument,
    saveContent
  }
})
