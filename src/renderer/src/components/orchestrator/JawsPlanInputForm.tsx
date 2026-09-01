import { Loader2 } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export type JawsPlanWorktreeOption = {
  id: string
  label: string
  path: string
  branch: string
}

export function JawsPlanInputForm({
  options,
  selectedOption,
  selectedWorktreeId,
  goal,
  submitting,
  error,
  onSelectedWorktreeChange,
  onGoalChange,
  onCancel,
  onSubmit
}: {
  options: JawsPlanWorktreeOption[]
  selectedOption: JawsPlanWorktreeOption | undefined
  selectedWorktreeId: string
  goal: string
  submitting: boolean
  error: string | null
  onSelectedWorktreeChange: (worktreeId: string) => void
  onGoalChange: (goal: string) => void
  onCancel: () => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="jaws-worktree">{translate('harness.gitWorktree', 'Git worktree')}</Label>
        <Select
          value={selectedWorktreeId}
          onValueChange={onSelectedWorktreeChange}
          disabled={submitting || options.length === 0}
        >
          <SelectTrigger id="jaws-worktree" className="w-full">
            <SelectValue placeholder={translate('harness.selectWorktree', 'Select a worktree')} />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start">
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedOption ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {selectedOption.branch} · {selectedOption.path}
          </p>
        ) : (
          <p className="text-xs text-destructive">
            {translate('harness.noGitRepository', 'Add a Git repository to use Jaws.')}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="jaws-goal">{translate('harness.goal', 'Issue or goal')}</Label>
        <Textarea
          id="jaws-goal"
          autoFocus
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          disabled={submitting}
          placeholder={translate(
            'harness.goalPlaceholder',
            'Paste a Linear issue or describe the outcome'
          )}
          className="min-h-28 resize-y"
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {translate('harness.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          disabled={!selectedOption || !goal.trim() || submitting}
          className="w-32"
        >
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {submitting
            ? translate('harness.starting', 'Starting…')
            : translate('harness.createPlan', 'Create plan')}
        </Button>
      </DialogFooter>
    </form>
  )
}
