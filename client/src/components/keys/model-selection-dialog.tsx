import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import type { ApiKey } from '../../../../shared/types'
import { X, Loader } from 'lucide-react'
import { useI18n } from '@/i18n'

interface Model {
  id: string
  name: string
  supportsTools?: boolean
  supportsVision?: boolean
}

interface ModelSelectionDialogProps {
  keyData: ApiKey
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ModelSelectionDialog({ keyData, open, onOpenChange }: ModelSelectionDialogProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [selectedModels, setSelectedModels] = useState<string[]>([])

  // Fetch available models
  const { data: modelsData, isLoading: modelsLoading, error: modelsError } = useQuery({
    queryKey: ['discover-models', keyData.id],
    queryFn: () => apiFetch(`/api/keys/${keyData.id}/discover-models`),
    enabled: open && keyData.platform !== 'aihorde',
  })

  // Add selected models. We send the full model objects we already discovered
  // (id + name + capability flags) so the backend doesn't have to re-fetch the
  // upstream /models endpoint a second time — that second call was the main
  // cause of the "add" action hanging on slow / keyless / local providers.
  const addModels = useMutation({
    mutationFn: (modelsToAdd: Model[]) =>
      apiFetch(`/api/keys/${keyData.id}/add-models`, {
        method: 'POST',
        body: JSON.stringify({ models: modelsToAdd }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      onOpenChange(false)
      setSelectedModels([])
    },
  })

  const handleModelToggle = (modelId: string) => {
    setSelectedModels(prev =>
      prev.includes(modelId)
        ? prev.filter(id => id !== modelId)
        : [...prev, modelId]
    )
  }

  const handleSelectAll = () => {
    if (!modelsData?.availableModels) return
    setSelectedModels(prev => [
      ...prev,
      ...modelsData.availableModels
        .filter(model => !prev.includes(model.id))
        .map(model => model.id)
    ])
  }

  const handleDeselectAll = () => {
    setSelectedModels([])
  }

  const handleAddSelected = () => {
    const chosen = models.filter(m => selectedModels.includes(m.id))
    if (chosen.length > 0) {
      addModels.mutate(chosen)
    }
  }

  const close = () => onOpenChange(false)

  const models = modelsData?.availableModels || []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-4xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>
            {t('keys.selectModels')} - {keyData.platform}
          </DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="min-h-[400px]">
          {modelsLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader className="size-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {t('keys.discoveringModels')}
              </span>
            </div>
          )}

          {modelsError && (
            <div className="py-12 text-center">
              <p className="text-destructive text-sm">
                {t('keys.modelDiscoveryFailed')}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {(modelsError as Error)?.message || t('keys.unknownError')}
              </p>
            </div>
          )}

          {!modelsLoading && !modelsError && (
            <>
              {models.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('keys.noModelsAvailable')}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm text-muted-foreground">
                      {t('keys.availableModelsCount', { count: models.length })}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={handleSelectAll}>
                        {t('keys.selectAll')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleDeselectAll}>
                        {t('keys.deselectAll')}
                      </Button>
                    </div>
                  </div>

                  <div className="max-h-96 overflow-y-auto border rounded-lg">
                    {models.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center p-3 border-b last:border-b-0 hover:bg-muted/50 cursor-pointer"
                        onClick={() => handleModelToggle(model.id)}
                      >
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(model.id)}
                          onChange={() => handleModelToggle(model.id)}
                          className="mr-3"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">
                            {model.name}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {model.id}
                          </div>
                          <div className="flex gap-2 mt-1">
                            {model.supportsTools && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800">
                                Tools
                              </span>
                            )}
                            {model.supportsVision && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">
                                Vision
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-between items-center mt-4">
                    <div className="text-sm text-muted-foreground">
                      {t('keys.selectedModelsCount', { count: selectedModels.length })}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={close}>
                        {t('common.cancel')}
                      </Button>
                      <Button 
                        size="sm" 
                        onClick={handleAddSelected}
                        disabled={selectedModels.length === 0 || addModels.isPending}
                      >
                        {addModels.isPending ? t('keys.addingModels') : t('keys.addSelectedModels', { count: selectedModels.length })}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  )
}