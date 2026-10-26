/** Public commerce DTOs; amounts and eligibility are always server-owned. */
export interface InvoiceRequest {
  order_nos: string[]; buyer_type: 'personal' | 'company'; buyer_title: string
  invoice_kind: 'normal' | 'special'; buyer_tax_id?: string; buyer_email?: string
  buyer_address?: string; buyer_phone?: string; buyer_bank?: string; buyer_bank_account?: string; remark?: string
}
export interface InvoiceableOrder { order_no: string; amount_rmb_cents: number; plan_code: string; domain?: string; paid_at: string; invoiced: boolean }
export interface UserInvoice { id: string; buyer_title: string; amount_rmb_cents: number; status: 'pending' | 'issued' | 'voided'; invoice_no?: string; created_at: string; orders: string[] }
export interface InvoicingSummary { paid_cents: number; invoiced_cents: number; remaining_cents: number; min_invoice_cents: number; min_special_invoice_cents?: number; daily_limit: number; submitted_today: number; orders: InvoiceableOrder[]; invoices: UserInvoice[] }
export interface LabPricing { min_seats: number; can_purchase: boolean; currency: string; seat_price_monthly_rmb: number; seat_price_yearly_rmb: number; grants_plan: string }
export interface SeatChange { recovery_warning?: string; status?: string; message?: string; order_no?: string; amount_rmb?: number; currency?: string; provider?: string; pay_url?: string; expires_at?: string; new_total_seats?: number }
export interface LabSummary { id: string; owner_id: string; name: string; seat_quota: number; status: string; my_role?: string }
export interface PaymentOrder { recovery_warning?: string; order_no: string; amount_rmb: number; currency: string; provider: string; pay_url: string; expires_at: string }

export interface RecoveredOrder { order_no: string; status: string; payment?: PaymentOrder; recovery_warning?: string }
